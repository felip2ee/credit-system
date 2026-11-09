# Pagamento por pagador (Pix e cartão) via Asaas — plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development` com ondas paralelas (`.claude/rules/08-parallel-subagent-driven-development.md`). Siga "Lean delivery" do `CLAUDE.md`: sem revisão por tarefa, implementadores não fazem commit, gate = testes da tarefa verdes.

**Meta:** cada cobrança Asaas leva o cliente Asaas do pagador real; checkout com a pergunta do pagador; cartão até 12x; dados do dono cifrados.

**Spec:** `docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md` (substitui o de 2026-11-03). Este plano substitui o plano anterior do mesmo arquivo. A antiga Tarefa 7 (layout de Total e Saldo em `client-order-form.tsx`) não tem relação com pagamento: sai deste plano e vira issue própria.

**Stack:** Next.js 14, `pg` sem ORM, zod, shadcn/ui, Asaas v3, `node:crypto`.

## Restrições globais

- Padrões do `AGENTS.md`: `withUserTransaction`, SQL parametrizado, zod, auditoria na mesma transação, `{ error: string | null, id? }`, `{ ok: false, reason }` para conflito, textos em pt-BR, migration só nova (`040` em diante).
- Nenhum `PoolClient` sai de um módulo de queries. Nenhuma chamada HTTP dentro de transação.
- Nunca em log, auditoria, erro ou exportação: número do cartão, CVV, validade, corpo da requisição, `creditCardHolderInfo`, CPF/CNPJ completo, CEP completo, chave PII.
- Dinheiro em centavos inteiros no código novo. `pix_charges.amount` = valor creditado; `total_charged` = valor cobrado.
- Nomes fixos (usar exatamente): tabela `payer_profiles`; colunas do spec; env `PII_ENCRYPTION_KEY`, `CARD_FEE_TABLE`, `CARD_MIN_INSTALLMENT_CENTS`; secret `pii_encryption_key`; constante `MAX_CARD_ATTEMPTS_PER_HOUR = 5`.
- Regras por nome: `06-security`, `05-testing`, `01-ddd`, `03-coding-principles`, `typescript/coding-standards`, `next/coding-standards`.

## Ondas

| Onda | Tarefas (paralelas) |
|---|---|
| 1 | T1, T2, T3, T7, T8 |
| 2 | T4 |
| 3 | T5 |
| 4 | T6 |

Depois da Onda 1, o coordenador roda `npm run type-check`: T2 tira `customerId` de `readAsaasConfig` e T3 tira de `AsaasClientSettings`; os dois juntos fecham o tipo.

---

### T1: Banco — `payer_profiles`, colunas de cartão, crédito do parcelamento

**Agente:** `database-architect`, `sonnet`. Skill: `/postgresql-database-engineering`.
**Files:** criar `db/migrations/040_payer_profiles_card_charges.sql`, `db/migrations/041_apply_asaas_payment_installments.sql`, `src/lib/wallet/asaas-installments.integration.test.ts`; alterar `src/lib/wallet/pix-charges.ts`, `src/lib/wallet/pix-charges.integration.test.ts`, `src/lib/db/rls.integration.test.ts`, `src/lib/lgpd/lgpd.integration.test.ts`, `src/app/api/webhooks/asaas/route.ts`, `src/app/api/webhooks/asaas/route.test.ts`.
**Depends-on:** none.

**Contrato SQL (040):**
- Tabela `payer_profiles` e colunas novas de `pix_charges` exatamente como no spec ("Modelo de dados"). `check` de formato nas colunas mascaradas:
  ```sql
  check (document_masked is null or document_masked ~ '^(\*\*\*\.\d{3}\.\*\*\*-\*\*|\*\*\.\d{3}\.\*\*\*/\*\*\*\*-\*\*)$')
  ```
- RLS `enable` + `force` em `payer_profiles`. Políticas para `app_runtime`:
  - linha de cliente: `app_context_present() and client_profile_id = app_user_id()`;
  - linha do Bureau: `client_profile_id is null and bureau_id = app_bureau_id()` e papel com `wallet:topup` (usar o helper de papel que as políticas de `pix_charges` já usam);
  - todas: `coalesce(current_setting('app.support_session_id', true), '') = ''`.
  Grants: `app_runtime` `select, insert, update`; `backup_reader` `select`; nenhum para `app_webhook`, `app_dispatch`. Dono `schema_owner`.
- `bind_pix_charge`: `drop` da assinatura `(uuid, text, text)` e `create` com `(p_id uuid, p_payment text, p_payload text default null, p_installment text default null, p_brand text default null, p_last4 text default null)`. Mesmo dono, `revoke`/`grant` da 019. Chamadas atuais com 3 argumentos continuam válidas.
- `lgpd_anonymize_client_account`: nova versão que também apaga a linha de `payer_profiles` do cliente. Corpo copiado da versão vigente; só o `delete` é novo.
- Comentário no topo: `pix_charges` guarda Pix e cartão (decisão D1 do spec); o nome é legado.

**Contrato SQL (041):** `apply_asaas_payment` nova versão, regras do spec ("Crédito do parcelamento"). Busca por `asaas_payment_id`, depois por `payload->'payment'->>'installment'`, depois por `externalReference`. Cartão credita no primeiro `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`; demais eventos do parcelamento = `duplicate`; estorno de qualquer parcela reverte uma vez pelo ramo atual. Pix inalterado.

**Contrato TS (`pix-charges.ts`, só acréscimos; nada é removido nesta tarefa):**
```ts
export type ChargeScope = { kind: "client"; clientProfileId: string } | { kind: "bureau"; bureauId: string };
export type ReserveChargeInput = {
  scope: ChargeScope; externalReference: string; amount: string;
  billingType: "PIX" | "CREDIT_CARD"; installments: number; feeAmount: string; totalCharged: string | null;
  payerKind: "owner" | "other"; payerDocumentMasked: string;
};
export async function lockChargeScope(client: PoolClient, scope: ChargeScope): Promise<void>;
export async function reserveCharge(client: PoolClient, identity: DbIdentity, input: ReserveChargeInput):
  Promise<{ ok: true; id: string; expiresAt: Date; reused: boolean } | { ok: false; reason: "invalid_amount" | "reference_taken" }>;
export async function setChargeCustomer(client: PoolClient, chargeId: string, asaasCustomerId: string): Promise<void>;
export async function bindAsaasCharge(client: PoolClient, chargeId: string, input: {
  asaasPaymentId: string; pixPayload?: string; asaasInstallmentId?: string | null; cardBrand?: string; cardLast4?: string;
}): Promise<boolean>;
export async function countRecentCardAttempts(client: PoolClient, requestedBy: string): Promise<number>; // última hora
export async function getChargeStatus(client: PoolClient, chargeId: string):
  Promise<{ status: PixChargeStatus; billingType: "PIX" | "CREDIT_CARD" } | null>;
```
- `reserveCharge`: `insert ... on conflict (external_reference) do nothing`; sem linha nova, lê a existente: mesmo `requested_by` = `{ ok: true, reused: true }`; outro autor = `reference_taken`. Auditoria `wallet.topup.request` com `{ amount, billingType, installments, payerKind, documentMasked }`.
- Webhook (`route.ts`): só se o teste provar que precisa (por exemplo, passar `payment.installment` no payload). Hoje o payload inteiro já vai para a função.

**Testes (integração, Postgres):**
- Parcelado 3x: 3 eventos `PAYMENT_CONFIRMED` (ids diferentes, mesmo `installment`) creditam uma vez; `PAYMENT_RECEIVED` depois = `duplicate`.
- Estorno da parcela 2 reverte o crédito inteiro uma vez; segundo estorno = `duplicate`; comissão de afiliado reverte como no Pix.
- Evento de parcela sem linha = `unknown_charge`. Evento antes do bind casa por `externalReference`.
- `reserveCharge` com a mesma referência e o mesmo autor devolve a mesma linha (`reused`); outro autor = `reference_taken`.
- `bureau_admin` lê zero linhas de `payer_profiles` de cliente; cliente não lê linha de outro cliente nem a do Bureau; sessão de suporte lê zero linhas.
- `check` recusa `document_masked` com 11 dígitos.
- `lgpd_anonymize_client_account` apaga `payer_profiles` do cliente.
- `bind_pix_charge` com 3 argumentos continua a funcionar (regressão).

### T2: Configuração, cifra, máscara, taxas e validadores (código puro)

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/pii/crypto.ts`, `src/lib/pii/crypto.test.ts`, `src/lib/wallet/card-fees.ts`, `src/lib/wallet/card-fees.test.ts`, `src/lib/validators/payer.ts`, `src/lib/validators/payer.test.ts`; alterar `src/lib/config.ts`, `src/lib/config.test.ts`, `src/lib/runtime-secrets.mjs`, `src/lib/runtime-secrets.test.ts`, `src/lib/mask-document.ts`, `src/lib/mask-document.test.ts`.
**Depends-on:** none.

**Contrato:**
```ts
// config.ts
export type PiiKeyring = { activeKeyId: string; keys: ReadonlyMap<string, Buffer> };
export function readPiiKeyring(env: Environment): PiiKeyring; // "id:base64,id:base64"; 32 bytes cada; ids únicos
export type CardFeeBand = { maxInstallments: number; percent: number; fixedCents: number };
export type CardFeeConfig = { bands: CardFeeBand[]; minInstallmentCents: number };
export function readCardFeeConfig(env: Environment): CardFeeConfig | null; // CARD_FEE_TABLE vazia = null
// AsaasConfig sem customerId; ASAAS_CUSTOMER_ID deixa de ser lido.

// pii/crypto.ts
export type PayerPii = { document?: string; postalCode?: string; addressNumber?: string };
export function encryptPayerPii(keyring: PiiKeyring, aad: string, pii: PayerPii): { ciphertext: Buffer; keyId: string };
export function decryptPayerPii(keyring: PiiKeyring, aad: string, ciphertext: Buffer, keyId: string): PayerPii;
export class PiiDecryptError extends Error {} // mensagem sem valores

// mask-document.ts (acréscimos; as máscaras atuais não mudam)
export function maskPayerDocument(digits: string): string;   // ***.456.***-** | **.345.***/****-**
export function maskPostalCode(digits: string): string;      // *****-678
export function maskPhone(e164: string): string;             // (**) *****-4321

// wallet/card-fees.ts
export function computeCardCharge(config: CardFeeConfig, input: { rechargeCents: number; installments: number }):
  { totalCents: number; feeCents: number; installmentCents: number[] };
export function listInstallmentOptions(config: CardFeeConfig, rechargeCents: number):
  Array<{ installments: number; totalCents: number; installmentCents: number }>;

// validators/payer.ts
export const cpfCnpjSchema;       // só dígitos, 11 ou 14, dígito verificador
export const postalCodeSchema;    // 8 dígitos
export const addressNumberSchema; // 1..10, "S/N" aceito
export const payerFieldsSchema;   // nome, documento, e-mail, telefone E.164, CEP, número (todos opcionais; a matriz decide)
export const cardFieldsSchema;    // número (Luhn, 13..19), nome impresso, mês, ano, CVV 3..4
```
- Fórmula do total, arredondamento e faixas: spec ("Cartão"). Erro tipado para parcelas fora de 1..12 ou abaixo da parcela mínima.
- `runtime-secrets.mjs`: acrescentar `PII_ENCRYPTION_KEY` à lista.
- Formato de `CARD_FEE_TABLE`: `maxParcelas:percent:fixoCentavos` separados por vírgula, por exemplo `1:2.99:49,6:3.49:49,12:3.99:49`. Faixas crescentes até 12.

**Testes:**
- Cifra: ida e volta; AAD diferente falha; chave antiga do anel decifra; tag adulterada falha; `PiiDecryptError` e erros de `readPiiKeyring` não contêm a chave nem o texto (spy em `console` e em `message`); IV diferente a cada cifra.
- Anel: chave de 31 bytes, id repetido, formato errado, vazio = erro claro.
- Taxas: 1x, 6x, 7x, 12x; recarga com dízima; soma das parcelas = total; líquido = recarga; 13x recusado; parcela mínima esconde planos; tabela vazia = `null`.
- Validadores: CPF e CNPJ válidos e inválidos (dígito errado, todos iguais); Luhn.
- Máscaras: formatos do spec; entrada de tamanho errado.
- `readAsaasConfig` sobe sem `ASAAS_CUSTOMER_ID`.

### T3: Cliente Asaas — clientes, Pix por cliente, cartão

**Agente:** `backend-specialist`, `sonnet`.
**Files:** alterar `src/lib/asaas/client.ts`, `src/lib/asaas/types.ts`, `src/lib/asaas/fake.ts`, `src/lib/asaas/index.ts`, `src/lib/asaas/asaas.test.ts`.
**Depends-on:** none.

**Contrato:**
```ts
export type AsaasClientSettings = { apiKey: string; baseUrl: string };
export type AsaasCustomerInput = {
  name: string; cpfCnpj: string; email: string; mobilePhone?: string; postalCode?: string; addressNumber?: string;
};
export type PixChargeInput = { customerId: string; amount: string; externalReference: string; description: string };
export type CardChargeInput = {
  customerId: string; externalReference: string; description: string;
  totalCents: number; installments: number; installmentCents: number;
  card: { holderName: string; number: string; expiryMonth: string; expiryYear: string; ccv: string };
  holder: { name: string; email: string; cpfCnpj: string; postalCode: string; addressNumber: string; phone: string };
  remoteIp: string;
};
export type CardChargeResult = { asaasPaymentId: string; asaasInstallmentId: string | null; brand: string; last4: string };
// AsaasClient ganha:
findCustomerByCpfCnpj(cpfCnpj: string): Promise<string | null>;  // GET /v3/customers?cpfCnpj=; mais antigo não apagado
createCustomer(input: AsaasCustomerInput & { externalReference?: string }): Promise<{ asaasCustomerId: string }>; // notificationDisabled: true
updateCustomer(asaasCustomerId: string, input: AsaasCustomerInput): Promise<void>; // POST /v3/customers/{id}
createCardCharge(input: CardChargeInput): Promise<CardChargeResult>;
export class CardDeclinedError extends Error {} // HTTP 400 no cartão; mensagem fixa em pt-BR
```
- `createPixCharge` usa `input.customerId`. Tirar o comentário "Não conferido: ... ASAAS_CUSTOMER_ID".
- Cartão: `billingType: "CREDIT_CARD"`; `value` à vista; `installmentCount` + `totalValue` só com `installments >= 2`; `creditCard`, `creditCardHolderInfo`, `remoteIp`.
- `call()`: o rótulo de erro é sempre fixo (`"GET /v3/customers"`), nunca o caminho com a query. Nenhum corpo em erro ou log.
- `InvoiceInput` ganha `installmentId?: string`; `scheduleInvoice` manda `installment` em vez de `payment` quando presente (marcar "não conferido" no comentário de cabeçalho, prova post-deploy).
- Fake: clientes em memória por documento; cartão terminado em `0002` recusa; parcelado devolve `ins_fake_<ref>`; `buildFakePaymentEvent` aceita `installment`.
- Comentário de cabeçalho: endpoints conferidos e não conferidos, com data.

**Testes:** payload Pix com `customer`; cartão à vista sem campos de parcela; 3x com `installmentCount` e `totalValue`; 400 vira `CardDeclinedError`; busca devolve o mais antigo não apagado e `null` sem resultado; `createCustomer` manda `notificationDisabled`; 5xx e timeout = `AsaasOutcomeUnknownError`; spy em `console` e em `message` prova que número, CVV e CPF nunca aparecem (inclusive no erro da busca por CPF).

### T4: Pagadores — dados do dono, cliente Asaas, exportação LGPD

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/payers/queries.ts`, `src/lib/payers/resolve.ts`, `src/lib/payers/resolve.test.ts`, `src/lib/payers/payers.integration.test.ts`; alterar `src/lib/lgpd/export.ts`, `src/lib/lgpd/types.ts`, `src/lib/lgpd/lgpd.integration.test.ts`.
**Depends-on:** T1, T2, T3.

**Contrato:**
```ts
export type PayerScope = ChargeScope; // de pix-charges.ts
export type PayerField = "name" | "document" | "email" | "phone" | "postalCode" | "addressNumber";
export type OwnerPayerView = {
  name: string | null; emailMasked: string; phoneMasked: string | null; documentMasked: string | null;
  postalCodeMasked: string | null; hasAddressNumber: boolean; source: "payer_profile" | "holder" | "none";
};
export type ResolvedPayer = {
  name: string; cpfCnpj: string; email: string; phone: string | null; postalCode: string | null; addressNumber: string | null;
};
// queries.ts (recebe PoolClient, roda dentro da transação de quem chama)
export async function getOwnerPayerView(client: PoolClient, identity: DbIdentity, scope: PayerScope): Promise<OwnerPayerView>;
export async function saveOwnerPayer(client: PoolClient, identity: DbIdentity, scope: PayerScope,
  patch: Partial<Record<PayerField, string>>, keyring: PiiKeyring): Promise<{ ok: true } | { ok: false; reason: "invalid" }>;
export async function loadOwnerPayerForCharge(client: PoolClient, identity: DbIdentity, scope: PayerScope,
  keyring: PiiKeyring): Promise<{ payer: Partial<ResolvedPayer>; payerProfileId: string | null;
  asaasCustomerId: string | null; owned: boolean; stale: boolean }>;
export async function claimAsaasCustomer(client: PoolClient, payerProfileId: string, asaasCustomerId: string,
  owned: boolean): Promise<string>; // devolve o id vencedor
// resolve.ts (puro + orquestração sem transação aberta)
export function missingPayerFields(view: OwnerPayerView, method: "PIX" | "CREDIT_CARD", nfseOn: boolean): PayerField[];
export function requiredOtherPayerFields(): PayerField[];
export async function resolveAsaasCustomer(deps: { asaas: AsaasClient; claim: (id: string, owned: boolean) => Promise<string>;
  markSynced: () => Promise<void> }, input: { payer: ResolvedPayer; kind: "owner" | "other";
  current: { asaasCustomerId: string | null; owned: boolean; stale: boolean } | null; payerProfileId: string | null }): Promise<string>;
```
- Ciclo do cliente Asaas: spec, passos 1 a 5.
- `saveOwnerPayer`: decifra o atual, mescla, cifra com a chave ativa, grava as máscaras; documento mudou = `asaas_customer_id = null`, `owned = false`; outro campo mudou = `stale = true`. Auditoria `payer.update` com `{ fields, documentMasked }`.
- `loadOwnerPayerForCharge`: linha com `pii_key_id` antigo é recifrada com a chave ativa na mesma transação. Sem linha e cliente com Titular próprio: usa documento, CEP e número do Titular (D8); a cópia cifrada acontece na primeira cobrança (`saveOwnerPayer` chamado por T5).
- AAD: `payer:<bureau_id>:<client_profile_id | "bureau">`.
- Exportação LGPD: bloco `paymentData` com `documentMasked`, `postalCodeMasked`, `hasAddressNumber`, `asaasCustomerLinked: boolean`. Nunca `pii_ciphertext`.

**Testes:**
- Integração: linha gravada não contém os dígitos do CPF nem do CEP no `bytea`; ida e volta pela API; blob copiado para outra linha não decifra; fallback do Titular; documento novo zera o cliente Asaas; dois `claimAsaasCustomer` concorrentes gravam um id só e os dois devolvem o mesmo; auditoria sem dígitos completos; exportação do Titular com conta traz só máscara; `bureau_admin` não exporta dado completo.
- Unidade (`resolve.ts`, fake do Asaas): id existente sem `stale` = nenhuma chamada; `stale` + `owned` = `updateCustomer`; `stale` sem `owned` = sem atualização; sem id + busca acha = adota com `owned = false`; sem id + busca vazia = cria com `externalReference`; "outros" nunca chama `updateCustomer` nem `claim`; `AsaasOutcomeUnknownError` na criação, segunda tentativa adota pela busca; matriz de `missingPayerFields` (4 colunas do spec, NFS-e ligada e desligada).

### T5: Checkout no servidor — actions, NFS-e e limpeza de órfãos

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/payments/checkout.ts`, `src/lib/payments/checkout.test.ts`, `src/lib/validators/checkout.ts`, `src/actions/checkout-context.ts`, `src/actions/checkout-context.test.ts`; alterar `src/actions/wallet-topup.ts`, `src/actions/wallet-topup.test.ts`, `src/actions/credits-topup.ts`, `src/actions/credits-topup.test.ts`, `src/lib/wallet/pix-charges.ts`, `src/lib/wallet/pix-charges.integration.test.ts`, `src/lib/nfse/queries.ts`, `src/lib/nfse/invoice.ts`, `src/lib/nfse/invoice.test.ts`, `src/lib/nfse/queries.integration.test.ts`.
**Depends-on:** T1, T2, T3, T4.

**Contrato:**
```ts
// validators/checkout.ts
export const checkoutSchema; // { amount, method: "PIX"|"CREDIT_CARD", payerKind: "owner"|"other",
                             //   idempotencyKey: uuid, installments?: 1..12, payer?: payerFieldsSchema,
                             //   card?: cardFieldsSchema, declaration?: true }
// payments/checkout.ts
export type CheckoutResult =
  | { error: null; id: string; method: "PIX"; pixPayload: string; qrImageBase64: string; expiresAt: string }
  | { error: null; id: string; method: "CREDIT_CARD" }
  | { error: string };
export async function runCheckout(session: Session, scope: ChargeScope, input: CheckoutInput,
  meta: { remoteIp: string; description: string }): Promise<CheckoutResult>;
// actions/checkout-context.ts ("use server")
export async function getCheckoutContextAction(values: { scope: "bureau" | "client"; amount: string }): Promise<{
  error: string | null; owner?: OwnerPayerView; missing?: { PIX: PayerField[]; CREDIT_CARD: PayerField[] };
  cardEnabled?: boolean; installmentOptions?: Array<{ installments: number; totalCents: number; installmentCents: number }>;
}>;
export async function getChargeStatusAction(id: string): Promise<{ error: string | null; status?: string }>;
// actions: requestTopupAction (Bureau) e requestClientTopupAction (portal) passam a receber checkoutSchema
// e delegam a runCheckout. Contrato de retorno atual mantido para o Pix.
```
- Ordem em `runCheckout`: `safeParse` → sessão → `hasPermission` (`wallet:topup` / `credits:topup`) → regras atuais (e-mail confirmado no portal, carteira existe) → matriz de campos (`missingPayerFields` / `requiredOtherPayerFields`; campo exigido e ausente = erro) → cartão: `readCardFeeConfig` não nulo, `computeCardCharge` no servidor → transação 1: `lockChargeScope`, teto de Pix pendentes, `countRecentCardAttempts < MAX_CARD_ATTEMPTS_PER_HOUR`, `saveOwnerPayer` (dono, campos novos), `reserveCharge` (`externalReference = idempotencyKey`; `reused` = devolve o estado atual sem chamar o Asaas) → fora da transação: `resolveAsaasCustomer` → `setChargeCustomer` → `createPixCharge` ou `createCardCharge` → transação 2: `bindAsaasCharge` → `revalidatePath`.
- Falhas: `CardDeclinedError` e erro definitivo = `cancelUnboundPixCharge`; `AsaasOutcomeUnknownError` = linha fica pendente (regra atual). Mensagens pt-BR seguras.
- `remoteIp` de `src/lib/account/request-meta.ts` (mesma regra de proxy confiável).
- Sem chave PII válida: erro "Pagamento indisponível. Contate o suporte." e log só com o nome do erro.
- `getChargeStatusAction`: só a cobrança do próprio solicitante (cliente) ou do próprio Bureau.
- Limpeza: tirar de `pix-charges.ts` o que ficou órfão (`createPixCharge`, `reserveClientPixCharge`, `lockClientPixCharges`, `bindPixCharge` se sem uso) e os testes deles.
- NFS-e: `nfse/queries.ts` devolve o valor da nota = `coalesce(total_charged, amount)` e `asaas_installment_id`; `invoice.ts` passa `installmentId` quando houver.

**Testes:**
- Actions (mocks de fronteira, padrão de `src/actions/CLAUDE.md`): sem permissão; e-mail não confirmado; campo faltando pela matriz; total adulterado no navegador é ignorado; mesma chave duas vezes chama o Asaas uma vez; 6ª tentativa de cartão na hora = recusa; recusa do cartão cancela a linha e não credita; "outros" não chama `saveOwnerPayer`; dono com dados completos e Pix não pede campos.
- Spy em `console`, em `writeAuditEvent` e no retorno: nenhum número de cartão, CVV, CPF completo ou CEP completo, nas duas actions.
- NFS-e: valor do cartão = total cobrado; parcelado manda `installmentId`; Pix inalterado.
- Uma simulação ponta a ponta com o driver fake (cartão 3x, dono Bureau): reserva → cliente → cobrança → 3 webhooks → saldo sobe uma vez.

### T6: Interface — pergunta do pagador, cartão, parcelas

**Agente:** `frontend-specialist`, `sonnet`. Skills: `/ui-ux-pro-max`, `/vercel:shadcn`.
**Files:** criar `src/components/payments/PayerStep.tsx`, `src/components/payments/PayerStep.test.tsx`, `src/components/payments/CardPaymentForm.tsx`, `src/components/payments/InstallmentSelect.tsx`, `src/components/payments/useChargePolling.ts`; alterar `src/components/wallet/TopupDialog.tsx`, `src/components/credits/ClientTopupDialog.tsx`.
**Depends-on:** T5.

**Contrato:**
- `PayerStep`: rádio "Os dados de pagamento são os do dono da conta ou outros?" com "Do dono da conta" (padrão) e "De outra pessoa ou empresa". Dono: lista mascarada de `OwnerPayerView`, link "Alterar" por campo (troca a máscara por campo vazio), campos só de `missing[method]`. Outros: todos os campos e a caixa "Declaro que estes dados são de quem paga".
- `CardPaymentForm`: número, nome impresso, validade, CVV com `autocomplete` `cc-number`, `cc-name`, `cc-exp`, `cc-csc`. Estado local só; nada em `localStorage`, contexto global ou URL. Limpa o estado ao fechar o diálogo.
- `InstallmentSelect`: opções de `getCheckoutContextAction` (total e valor da parcela por plano). O navegador não calcula taxa.
- Os dois diálogos: valor → forma (Cartão só com `cardEnabled`) → `PayerStep` → cartão → confirmar. Chave de idempotência `crypto.randomUUID()` por envio; botão travado. Pix: QR como hoje. Cartão: `useChargePolling` a cada 3 s por até 60 s, depois "Pagamento em análise. O saldo atualiza sozinho."
- Textos em pt-BR. Acessibilidade: `fieldset`/`legend` no rádio, erro ligado ao campo por `aria-describedby`.

**Testes:** `PayerStep`: dono completo não mostra campos; dono sem CEP com cartão mostra só CEP e número; "Alterar" abre o campo; "outros" exige a declaração. Navegação real com Playwright MCP contra o driver fake, nas duas telas, em 360 px e desktop: Pix dono, cartão 3x outros, cartão recusado.

### T7: Stack, instalador e variáveis

**Agente:** `devops-engineer`, `sonnet` (a geração da chave e a regra de reuso têm lógica e testes).
**Files:** alterar `docker-stack.yml`, `scripts/setup/setup_production.py`, `scripts/setup/install_secrets.py`, `scripts/setup/install_collect.py`, `scripts/setup/test_setup_production.py`, `scripts/setup/test_install_collect.py`, `scripts/setup/test_install_flow.py`, `scripts/setup/test_stack_vars.py`, `scripts/setup/README.md`, `.env.example`, `.env.local.example`, `.github/workflows/ci.yml`.
**Depends-on:** none.

**Contrato:**
- `docker-stack.yml`, serviço `reino_app`: `ASAAS_DRIVER: ${ASAAS_DRIVER:-asaas}`, `ASAAS_API_BASE_URL: ${ASAAS_API_BASE_URL:?...}`, `ASAAS_API_KEY_FILE`, `ASAAS_WEBHOOK_TOKEN_FILE`, `PII_ENCRYPTION_KEY_FILE: /run/secrets/pii_encryption_key`, `CARD_FEE_TABLE: ${CARD_FEE_TABLE:-}`, `CARD_MIN_INSTALLMENT_CENTS: ${CARD_MIN_INSTALLMENT_CENTS:-500}`, as seis `NFSE_*` com padrão vazio (`NFSE_RETAIN_ISS` padrão `false`). Secrets novos `asaas_api_key`, `asaas_webhook_token`, `pii_encryption_key` (`external: true`) na lista do serviço e no bloco `secrets`. Nada de `ASAAS_CUSTOMER_ID`.
- `setup_production.py`: `SECRET_NAMES` + os três; `build_secrets` gera `pii_encryption_key = "k1:" + base64(secrets.token_bytes(32))` e `asaas_webhook_token = gen_hex(32)` se vazio; `SECRET_QUESTIONS` pergunta a chave da API Asaas (obrigatória); `ENV_KEYS` com `ASAAS_API_BASE_URL`, `CARD_FEE_TABLE`, `CARD_MIN_INSTALLMENT_CENTS` e `NFSE_*`. Credenciais "GUARDAR" levam a chave PII com o aviso "sem esta chave os dados de pagamento cifrados ficam ilegíveis".
- Reuso (`install_secrets.py`): `pii_encryption_key` ausente com outros secrets presentes = gerar e avisar (atualização de uma versão sem a chave). Nunca recriar um `pii_encryption_key` existente.
- `.env.example` e `.env.local.example`: tirar `ASAAS_CUSTOMER_ID`; pôr `PII_ENCRYPTION_KEY=dev:` + base64 público de 32 bytes com o aviso "só dev", `CARD_FEE_TABLE=1:2.99:49,6:3.49:49,12:3.99:49`, `CARD_MIN_INSTALLMENT_CENTS=500`.
- `ci.yml`: `PII_ENCRYPTION_KEY` de teste e `CARD_FEE_TABLE` no job de testes.

**Testes:** `python -m unittest` em `scripts/setup`: os três secrets novos na criação; chave PII com 32 bytes e prefixo `k1:`; reuso gera a chave que falta e não toca a existente; `test_stack_vars.py` acha cada `${VAR}` da stack no `ENV_KEYS` ou com padrão; nenhum valor de secret na saída (`redact`). `docker stack config -c docker-stack.yml` (ou `docker compose config`) com um `.env.production` de exemplo, se o Docker estiver disponível.

### T8: Documentos

**Agente:** `documentation-writer`, `haiku`. Spec completo: seção "Documentos que mudam".
**Files:** alterar `AGENTS.md`, `PRODUCT.md`, `docs/architecture.md`, `docs/operations/lgpd.md`, `docs/operations/nfse.md`, `docs/setup.md`, `docs/onboarding.md`; criar `docs/operations/payments.md`.
**Depends-on:** none.

**Contrato:** texto em pt-BR, Simplified Technical English, resultado primeiro. A regra nova do `AGENTS.md` usa o texto exato do spec. `docs/architecture.md`: linhas novas na tabela "Decisões" para D1, D5 (cifra de aplicação com anel de chaves), D10 e D16. `docs/operations/payments.md`: chave PII (gerar, guardar, rotacionar, perda), taxas e parcela mínima, recusa de cartão, cliente Asaas órfão, cobranças antigas com o cliente fixo. Não duplicar regra que já está em outro documento: apontar para ele.

**Teste:** nenhum (documento). O coordenador confere os links relativos.

---

## Fora do plano (sem tarefa)

- Revisão: uma vez, ao fechar a issue (`/code-review`, `code-reviewer` + `security-reviewer`), com foco em cifra, RLS de `payer_profiles`, dados de cartão e crédito do parcelamento.
- Layout de Total e Saldo em `client-order-form.tsx` (antiga Tarefa 7): issue própria.

## Acompanhamento pós-deploy (vai para o corpo do PR)

- Conferir `GET /v3/customers?cpfCnpj=` e o filtro de clientes apagados na conta real.
- Confirmar que a conta Asaas aceita cartão direto pela API e o formato real do webhook de parcelamento.
- Conferir a nota do parcelamento (`installment` em `POST /v3/invoices`) e o valor aceito pela prefeitura; o contador valida o valor da nota no cartão.
- Ajustar `CARD_FEE_TABLE` e `CARD_MIN_INSTALLMENT_CENTS` com a tabela real da conta.
- Confirmar que `notificationDisabled` evita e-mail do Asaas ao pagador.
- Emitir uma NFS-e de teste e conferir nome e CPF/CNPJ do pagador.
- Guardar a chave PII no gerenciador de senhas da operação.
