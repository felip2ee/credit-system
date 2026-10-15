# M3b — Financeiro restante Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** O cliente final tem carteira e recarrega por PIX. Cada pedido reserva, captura ou libera saldo de forma idempotente (online e balcão). O operador registra pagamento de balcão. O superadmin gera e quita o repasse ao Bureau. Cada PIX confirmado agenda uma NFS-e.

**Architecture:** Duas migrations novas: `015_client_wallet_settlement.sql` (carteira do cliente, liquidação por pedido, valor a repassar, pagamento de balcão) e `016_payouts_nfse.sql` (repasse, comprovante, NFS-e). Toda mudança de saldo passa por funções SQL (como no M3a). A liquidação (`reserve_order`, `capture_order`, `release_order`) é atômica em SQL porque mexe em duas tabelas. Camadas: Server Action → `src/lib/<domínio>/queries.ts` → função SQL.

**Tech Stack:** Next.js 14.2, PostgreSQL 18.6 (RLS), node-postgres, zod, Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-14-m3b-financeiro-restante-design.md`. Base: M3a (PR #57) na branch `feature/m3a-carteira-bureau`; crie a branch `feature/m3b-financeiro-restante` a partir dela. Issues: #27 (parcial), #30, #31, #32, #33. Aprovação: D1–D4 da spec foram aceitas com a ordem de invocar este plano; confirme na revisão do plano.

## Global Constraints

- Crie `db/migrations/015_client_wallet_settlement.sql` (Task 1) e `db/migrations/016_payouts_nfse.sql` (Task 5). Não edite as migrations 003–014. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329`. `src/test/seed.ts` pertence à Task 1. As outras tasks criam os helpers de teste no próprio arquivo de teste.
- Passe a identidade (`DbIdentity`) inteira. Chame `hasPermission(subject, permission)` com o objeto.
- `bureau_id` de escrita vem da identidade. Exceções: ações do superadmin sobre repasse e NFS-e recebem o `bureau_id` alvo (zod uuid + `payout:manage`).
- Dinheiro: `numeric(15,2)`; em TypeScript, string decimal; some e compare em centavos inteiros; nunca `number` de ponto flutuante. Reuse `src/lib/catalog/money.ts`. Faixa: `> 0` e `<= 99999999.99`.
- Só as funções SQL escrevem em carteiras, lançamentos, liquidações, repasses e acréscimos. A role `app_runtime` não tem INSERT/UPDATE direto nessas tabelas. Funções `SECURITY DEFINER` fixam `search_path` e qualificam o schema. Copie as convenções de owner, `revoke` e `grant` da 012–014.
- O webhook roda só na role `app_webhook` (pool próprio, `DATABASE_WEBHOOK_URL`). Qualquer função nova que o webhook chame segue o mesmo modelo: `EXECUTE` só para `app_webhook`.
- Auditoria no mesmo cliente da transação. Nunca CPF/CNPJ, token, chave de API, conteúdo ou nome de comprovante em `metadata`.
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio.
- Upload de comprovante: tamanho máximo 5 MB; tipos PDF, PNG e JPEG conferidos por magic bytes (não pelo MIME enviado); varredura ClamAV que falha fechada; só a chave relativa sai do módulo `src/lib/documents`. Não registre conteúdo nem nome do arquivo em log.
- Segredos só em variáveis de ambiente. Nunca no repositório.
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da última onda.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Decisões deste plano que completam a spec

1. **Comprovante.** Não existe tabela `documents` nem serviço de upload no repositório. O repasse guarda o arquivo direto: `payouts.receipt_object_key`, `receipt_mime`, `receipt_sha256`. A spec dizia `receipt_document_id`; o plano substitui por estas três colunas. A Task 6 cria o serviço de upload e a rota de download.
2. **Permissões** todas na Task 2 (`credits:read|topup`, `counter:read|write`, `payout:read|manage`, `nfse:manage`), para que as tasks 6 e 7 não editem `permissions.ts`.
3. **Estorno de recarga do cliente.** O evento `PAYMENT_REFUNDED` numa cobrança de cliente debita a carteira do cliente com o mesmo modelo do Bureau (`reversal` até o disponível, resto em `refund_shortfall`). A Task 1 cobre isso.
4. **Caixa.** O teste de conciliação soma carteiras de clientes, carteiras de Bureaus e valor a repassar; ele não consulta o Asaas.
5. **Repasse negativo.** Se os acréscimos menos estornos até o corte somam `<= 0`, `create_payout` recusa (`nothing_to_pay`). O saldo negativo entra no próximo repasse.
6. **Uma branch, um PR.** São 7 tasks (limite de 8 da spec). Se o diff passar de ~6.000 linhas, divida o PR em M3b-1 (tasks 1–4) e M3b-2 (tasks 5–7).

## Review Focus

1. Captura e liberação do mesmo `order_ref` ao mesmo tempo, ou duas capturas — Task 1: `concurrent capture and release of one order resolve to a single state`.
2. Preço ou custo muda entre a reserva e a captura — Task 1/2: `capture uses the values stored at reservation`.
3. Dois repasses criados ao mesmo tempo pegam o mesmo acréscimo — Task 5: `concurrent create_payout never shares an accrual`.
4. Upload de comprovante: arquivo grande, magic bytes que não batem, scanner fora do ar, download de outro Bureau — Task 6: `receipt upload rejects … and download is tenant-scoped`.
5. Falha ou duplicidade da NFS-e atinge o crédito — Task 6: `nfse failure and duplicate invoice events never change the wallet`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/015_client_wallet_settlement.sql` | carteira e lançamentos do cliente, `client_wallet_apply`, `order_settlements`, `reserve_order`/`capture_order`/`release_order`, `bureau_payable_entries`, `counter_payments`, extensão de `pix_charges` e de `apply_asaas_payment` para cliente (inclui estorno), backfill | 1 |
| `src/test/seed.ts` | helpers de cliente, carteira do cliente, liquidação (acrescenta) | 1 |
| `src/lib/wallet/client-wallet.integration.test.ts`, `src/lib/settlement/settlement.integration.test.ts` | isolamento, imutabilidade, concorrência, conciliação | 1 |
| `src/lib/db/permissions.ts` (+ teste) | todas as permissões novas | 2 |
| `src/lib/wallet/client-queries.ts` (+ teste) | `getClientWallet`, `listClientLedger` | 2 |
| `src/lib/settlement/{queries,types}.ts` (+ testes) | `reserveOrder`, `captureOrder`, `releaseOrder`, `getSettlement` | 2 |
| `src/lib/counter-payments/{queries}.ts`, `src/lib/validators/counter-payments.ts`, `src/actions/counter-payments.ts` (+ testes) | registrar, anular, listar por Dossiê | 2 |
| `src/lib/payables/queries.ts` (+ teste) | saldo a repassar e extrato (leitura) | 2 |
| `src/lib/wallet/pix-charges.ts` (+ teste de integração) | cobrança de cliente, leitura de cobrança de cliente | 3 |
| `src/actions/credits-topup.ts` (+ teste) | `requestClientTopupAction` | 3 |
| `db/migrations/016_payouts_nfse.sql` | `payouts`, `payout_items`, `create_payout`/`mark_payout_paid`/`cancel_payout`, colunas e função de NFS-e | 5 |
| `src/lib/payouts/payouts.integration.test.ts` | concorrência, isolamento, conciliação do repasse | 5 |
| `src/lib/payouts/{queries,receipt}.ts` (+ testes), `src/lib/validators/payouts.ts`, `src/actions/payouts.ts`, `src/app/api/payouts/[id]/receipt/route.ts` | repasse, upload e download de comprovante | 6 |
| `src/lib/nfse/queries.ts`, `src/lib/asaas/{client,types}.ts`, `src/app/api/webhooks/asaas/route.ts`, `src/actions/nfse.ts`, `docs/operations/nfse.md` (+ testes) | NFS-e: agendar, eventos, nova tentativa | 6 |
| `src/app/(portal)/portal/credits/`, `src/components/credits/`, `src/app/(dashboard)/settings/counter-payments/`, `src/components/counter-payments/`, `src/components/layout/sidebar.tsx`, `src/app/(portal)/layout.tsx` | telas do cliente e do balcão | 4 |
| `src/app/(dashboard)/settings/payouts/`, `src/app/(superadmin)/superadmin/payouts/`, `src/app/(superadmin)/superadmin/nfse/`, `src/components/payouts/`, `src/components/superadmin/SuperadminNav.tsx` | telas de repasse e NFS-e | 7 |

**Arquivos compartilhados e dono único:** `src/lib/db/permissions.ts` → Task 2. `src/test/seed.ts` → Task 1. `src/lib/wallet/pix-charges.ts` → Task 3. `src/lib/asaas/client.ts` e `src/app/api/webhooks/asaas/route.ts` → Task 6. `src/components/layout/sidebar.tsx` → Task 4. `SuperadminNav.tsx` → Task 7.

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | schema, RLS e funções da carteira do cliente e da liquidação |
| 2 | 2, 5 | a Task 2 usa as tabelas da 015; a Task 5 (migration 016) só depende da 015; arquivos disjuntos |
| 3 | 3, 6 | a Task 3 usa a Task 2; a Task 6 usa as tasks 2 e 5; arquivos disjuntos |
| 4 | 4, 7 | só consomem as tasks 2, 3 e 6; arquivos disjuntos |

Review uma vez, no fim, sobre o diff inteiro: `code-reviewer` e `security-reviewer` (dinheiro, upload, webhook, RLS). Um review final em `opus` é permitido por tocar dinheiro e segurança; nunca como implementador.

---

### Task 1: Migration 015 — carteira do cliente, liquidação, acréscimos e balcão

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/015_client_wallet_settlement.sql`
- Create: `src/lib/wallet/client-wallet.integration.test.ts`, `src/lib/settlement/settlement.integration.test.ts`
- Modify: `src/test/seed.ts` (acrescenta helpers)

**Depends-on:** none (M3a mergeado na branch base)

**Contrato do schema** (spec, decisões 1–5, 10, 12):
- `client_wallets(client_profile_id pk, bureau_id, available, reserved)`, CHECK `>= 0`, FK composta `(bureau_id, client_profile_id)` para `profiles`. Trigger cria a carteira quando nasce um `profiles` com papel `client`; backfill das contas existentes sob a role `auth_profile_lookup` (modelo da 013, que prova o backfill sob RLS).
- `client_ledger_entries`: mesmas colunas do `ledger_entries` do M3a mais `client_profile_id`; `kind` em `topup | reserve | capture | release | reversal`; imutável (trigger bloqueia UPDATE e DELETE, inclusive para o dono); `unique (client_profile_id, idempotency_key)`; coluna `seq` identity.
- `pix_charges.client_profile_id` nulo; CHECK: a cobrança é do Bureau ou do cliente (`client_profile_id` preenchido implica cobrança de cliente; o `bureau_id` continua preenchido). Amplie a política de tenant: o cliente lê só as próprias cobranças.
- `order_settlements(id, order_ref unique, bureau_id, mode, client_profile_id, price, cost, quote jsonb, status, created_at, closed_at)`; `mode` em `online | counter`; `status` em `reserved | captured | released`; CHECK `price >= cost`; `client_profile_id` obrigatório se `mode = 'online'` e nulo se `counter`.
- `bureau_payable_entries(id, bureau_id, kind, amount, order_ref, created_at)`, só INSERT (trigger); `kind` em `accrual | reversal | payout`. (A coluna `payout_id` e os itens do repasse ficam na migration 016.)
- `counter_payments(id, bureau_id, dossier_id, method, amount, received_at, registered_by, note, voided_at, voided_by, void_reason)`; FK composta para `dossiers`; `method` em `cash | pix | card_machine | transfer | other`; trigger bloqueia DELETE e qualquer UPDATE que não seja a anulação (só `voided_*`, uma vez, com motivo não vazio).
- `refund_shortfall` já existe em `pix_charges` (014); reuse-o para cobranças de cliente.

**Contrato das funções:**
- `client_wallet_apply(p_client_profile_id uuid, p_kind text, p_amount numeric, p_idempotency_key text, p_reference text, p_reason text)` espelha `wallet_post_entry` (mesmo retorno e mesmas razões de falha). **Interna**: `app_runtime` não executa; só as funções abaixo e `apply_asaas_payment` a chamam.
- `reserve_order(p_order_ref uuid, p_mode text, p_client_profile_id uuid, p_price numeric, p_cost numeric, p_quote jsonb)` devolve `(ok boolean, reason text, status text)`. O Bureau vem de `app_bureau_id()`.
  - `online`: reserva `p_price` na carteira do cliente. `counter`: reserva `p_cost` na carteira do Bureau.
  - Grava `order_settlements` com `status = 'reserved'`. Razões: `insufficient_balance`, `price_below_cost`, `not_allowed` (Bureau ou cliente que não bate com a identidade), `invalid_amount`, `already_exists` (mesmo `order_ref` com dados diferentes). Repetir com os mesmos dados devolve o estado atual sem mexer em saldo.
- `capture_order(p_order_ref uuid)`: lê os valores **gravados** na liquidação (nunca recebe preço de novo). `online`: captura `price` do cliente e insere `accrual` de `price − cost`. `counter`: captura `cost` do Bureau. `status` vira `captured`. Idempotente; em `released` devolve `invalid_state`.
- `release_order(p_order_ref uuid)`: libera a reserva; `status` vira `released`; sem acréscimo. Idempotente; em `captured` devolve `invalid_state`.
- As três usam chaves de idempotência derivadas do `order_ref` (`'order:reserve:' || order_ref`, etc.), travam a linha da liquidação e depois as carteiras, sempre na mesma ordem (liquidação → carteira do cliente → carteira do Bureau), e rejeitam chaves de chamador que comecem com `order:` ou `pix` na `wallet_apply`/`client_wallet_apply`.
- `apply_asaas_payment` (replace): cobrança com `client_profile_id` credita `client_ledger_entries` (`topup`, chave `'pix:' || charge.id`) e o estorno cria `reversal` com `refund_shortfall`, no mesmo modelo do Bureau. Mantenha owner, `search_path`, `grant` só para `app_webhook` e a auditoria estreita (`wallet.topup`, `wallet.reversal`; amplie a política `audit_logs_topup_insert` para o ledger do cliente sem abri-la a outras ações).
- Funções de leitura e as três de liquidação: `grant execute` para `app_runtime`.

**RLS:**
- Tenant lê e insere só o próprio Bureau (modelo do M1). O cliente lê só a própria carteira, o próprio extrato e as próprias cobranças e liquidações.
- `bureau_payable_entries`: `bureau_admin` e `operator` do Bureau leem; o superadmin sem suporte lê qualquer Bureau (exceção estreita, só SELECT, só esta tabela e `payouts` na 016).
- `counter_payments`: `operator` e `bureau_admin` leem e inserem; a anulação passa por função `void_counter_payment(p_id uuid, p_reason text)` (não UPDATE direto).

**Testes (casos mínimos):**
- Reserva/captura/liberação online e balcão movem os saldos conforme o contrato; acréscimo só no online; `price_below_cost` recusa.
- Idempotência: repetir cada função não altera saldo; `invalid_state` nos dois cruzamentos.
- `concurrent capture and release of one order resolve to a single state`.
- `capture uses the values stored at reservation`.
- A carteira do cliente nunca fica negativa, mesmo com reservas concorrentes.
- Conciliação: soma dos lançamentos de cada cliente é igual a `available + reserved`; soma dos acréscimos e estornos de um Bureau é igual ao que a view de saldo a repassar informa.
- Isolamento: cliente A não lê a carteira do cliente B nem a do Bureau; Bureau A não lê liquidação, acréscimo ou pagamento de balcão do Bureau B; `operator` não executa funções de superadmin.
- `app_runtime` não faz INSERT/UPDATE direto em carteiras, lançamentos, liquidações e acréscimos; não executa `client_wallet_apply`.
- Estorno de recarga de cliente: saldo cheio, parcial, zero e evento duplicado.
- `counter_payments`: UPDATE de valor e DELETE falham; anulação exige motivo, vale uma vez e não altera o valor.
- Backfill: um cliente criado antes da 015 passa a ter carteira (prova sob RLS, como na 013).

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/wallet src/lib/settlement` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 2: Serviços de cliente, liquidação, balcão e valor a repassar

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/lib/db/permissions.ts`, `src/lib/db/permissions.test.ts`
- Create: `src/lib/wallet/client-queries.ts`, `src/lib/wallet/client-queries.integration.test.ts`
- Create: `src/lib/settlement/queries.ts`, `src/lib/settlement/types.ts`, `src/lib/settlement/queries.integration.test.ts`
- Create: `src/lib/counter-payments/queries.ts`, `src/lib/counter-payments/queries.integration.test.ts`
- Create: `src/lib/validators/counter-payments.ts`, `src/actions/counter-payments.ts`, `src/actions/counter-payments.test.ts`
- Create: `src/lib/payables/queries.ts`, `src/lib/payables/queries.integration.test.ts`

**Depends-on:** 1

**Contrato:**
- Permissões (spec, decisão 9): `client` → `credits:read`, `credits:topup`. `operator` → `counter:read`, `counter:write`. `bureau_admin` → `counter:read`, `counter:write`, `payout:read`. `superadmin` → `payout:manage`, `nfse:manage`, `payout:read`. Superadmin em suporte herda as do operator pela regra existente. Defina todas aqui, inclusive as das tasks 6 e 7.
- `client-queries.ts`: `getClientWallet(client)` → `{ available, reserved } | null`; `listClientLedger(client, { limit, cursor })` → `{ rows, nextCursor }` por `seq` numérico. **Ordene por `client_ledger_entries.seq` qualificado** (o bug de `order by seq` sobre a coluna de saída em texto já ocorreu no M3a); inclua teste que cruza 9→10 e 99→100.
- `settlement/queries.ts`: `reserveOrder(client, { orderRef, mode, clientProfileId, quote })`, `captureOrder(client, orderRef)`, `releaseOrder(client, orderRef)`, `getSettlement(client, orderRef)`. `quote` é o resultado de `quoteOrder` (M2): `price`, `cost` e as linhas com `product_version_id`; a função extrai o total e grava o resto em `quote`. Cada função chama a função SQL e traduz o resultado em `{ ok: true, status } | { ok: false, reason }`. Nenhuma regra de saldo em TypeScript.
- `counter-payments`: `registerCounterPayment(identity, input)` (zod: `dossierId` uuid, `method` do enum, `amount` string decimal em centavos > 0, `note` até 500 caracteres, `receivedAt` data), `voidCounterPayment(identity, { id, reason })`, `listCounterPayments(client, dossierId)` com a soma contra o preço da liquidação (se existir). As Server Actions `registerCounterPaymentAction` e `voidCounterPaymentAction` exigem `counter:write`, gravam auditoria (`counter.register`, `counter.void`) e chamam `revalidatePath("/settings/counter-payments")`.
- `payables/queries.ts`: `getPayableBalance(client, bureauId)` → string decimal; `listPayableEntries(client, bureauId, { limit, cursor })`. Só leitura. Operador não lê (permissão `payout:read` só do `bureau_admin` e superadmin).
- Nenhum `number` de ponto flutuante em valores.

**Testes (casos mínimos):**
- Cada permissão por papel, incluindo superadmin em suporte e `client`.
- Liquidação: `reserveOrder` → `captureOrder` e → `releaseOrder` pelos dois modos; repetição idempotente; `quote` gravado intacto; `price_below_cost`.
- Balcão: zod rejeita valor zero, valor com 3 casas, método fora do enum e `dossierId` inválido; operador registra; `client` recebe erro; anular exige motivo; anulação repetida falha; auditoria sai com ação e sem dados sensíveis.
- Soma contra o preço: dois pagamentos parciais somam; anulado não conta.
- `listClientLedger`: ordem numérica correta cruzando 9→10 e 99→100, `limit` máximo 100, cursor sem repetir linhas.
- `getPayableBalance` bate com a soma dos acréscimos e estornos; Bureau B não aparece para o admin do Bureau A.
- Soma em centavos: `0.10 + 0.20` dá `0.30`.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/wallet src/lib/settlement src/lib/counter-payments src/lib/payables src/actions/counter-payments.test.ts src/lib/db` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 3: Recarga online do cliente

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/lib/wallet/pix-charges.ts`, `src/lib/wallet/pix-charges.integration.test.ts`
- Create: `src/actions/credits-topup.ts`, `src/actions/credits-topup.test.ts`
- Modify: `src/lib/validators/wallet.ts` (esquema de recarga do cliente, acrescenta)

**Depends-on:** 1, 2

**Contrato:**
- `pix-charges.ts`: `createClientPixCharge(client, identity, amount)` insere a cobrança com `client_profile_id = identity.userId`, mesma faixa (R$ 10,00 a R$ 5.000,00) e mesma expiração (30 minutos) do Bureau; `listClientPixCharges(client, clientProfileId)` devolve o estado efetivo (`pending` vencida vira `expired`) sem `asaas_payment_id`. O limite de 10 cobranças pendentes passa a valer por cliente.
- `requestClientTopupAction({ amount })`: zod → sessão → `credits:topup` → verifica que a carteira do cliente existe → adaptador Asaas (o mesmo `createPixCharge` do M3a) → grava a cobrança depois da resposta do Asaas → devolve `{ error, id? }` com o QR. O `asaasPaymentId` nunca vai ao navegador. Valores sugeridos (R$ 20, 50, 100, 200) são constantes exportadas para a tela; o servidor valida só a faixa.
- O webhook não muda nesta task: a função SQL da Task 1 já credita a carteira do cliente.

**Testes (casos mínimos):**
- Valor abaixo do mínimo, acima do máximo e com 3 casas são rejeitados.
- `client` solicita; `operator`, `bureau_admin` e usuário sem carteira recebem erro; falha do adaptador não deixa linha `pending`.
- O cliente A não lê as cobranças do cliente B.
- Ponta a ponta com o driver `fake`: cobrança do cliente → evento de pagamento pelo webhook (pool `app_webhook`) → carteira do cliente creditada com o valor local e carteira do Bureau intacta; evento repetido não credita duas vezes; pagamento depois do vencimento credita.
- Teto de 10 pendentes por cliente.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/wallet src/actions/credits-topup.test.ts src/app/api/webhooks` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 4: Telas do cliente e do balcão

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/app/(portal)/portal/credits/page.tsx`, `src/app/(portal)/portal/credits/receipts/[id]/page.tsx`
- Create: `src/components/credits/{ClientBalance,ClientTopupDialog,ClientLedgerTable}.tsx`
- Create: `src/app/(dashboard)/settings/counter-payments/page.tsx`
- Create: `src/components/counter-payments/{CounterPaymentForm,CounterPaymentList}.tsx`
- Modify: `src/components/layout/sidebar.tsx`, `src/app/(portal)/layout.tsx`

**Depends-on:** 2, 3

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga `src/components/wallet/*` (M3a), `src/components/CLAUDE.md` e as páginas de `settings`.
- `/portal/credits`: exige `credits:read`; mostra saldo disponível e reservado (use `formatCurrency` de `src/lib/utils.ts`), botão "Recarregar" com `credits:topup`, valores sugeridos (R$ 20, 50, 100, 200) mais campo livre, QR e copia-e-cola, `router.refresh()` a cada 5 s enquanto a cobrança está `pending`, e o extrato por cursor. **Remonte a tabela** com `key={rows[0]?.id ?? "empty"}` (bug de dados velhos já visto no M3a). Ignore Escape e fechamento enquanto a requisição está pendente. Estado "Expirado" informa que um pagamento tardio ainda é creditado.
- Recibo `/portal/credits/receipts/[id]`: mostra valor, data, identificador da cobrança e, se existir, o link da NFS-e (campo preenchido pela Task 6; mostre "Nota em emissão" enquanto vazio). Só o dono da cobrança e só se estiver `paid`.
- `/settings/counter-payments`: lista por Dossiê, soma contra o preço da liquidação, formulário de registro (método, valor com vírgula, data, nota) e anulação com motivo obrigatório. O operador e o `bureau_admin` veem e gravam; o `client` não acessa. Chave de idempotência não se aplica: a anulação repetida falha na função.
- Sidebar: item "Pagamentos de balcão" (permissão `counter:read`) e item "Repasses" (permissão `payout:read`; a página nasce na Task 7). Portal: link "Créditos" no layout do portal.
- Textos em pt-BR. Estados de erro e carregamento visíveis; foco e rótulos acessíveis nos diálogos.

**Testes:** UI de apresentação não leva teste. Teste só lógica com ramo extraída em função pura (parse do valor da recarga, decisão de mostrar botão por permissão). Verificação visual: `npm run dev` com `ASAAS_DRIVER=fake`, entre como cliente, operador e `bureau_admin`. Se não for possível abrir o navegador, diga isso no relatório.

- [ ] Implemente, rode `npm run lint && npm run type-check` e os testes das funções extraídas.
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

### Task 5: Migration 016 — repasse e colunas de NFS-e

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/016_payouts_nfse.sql`
- Create: `src/lib/payouts/payouts.integration.test.ts`

**Depends-on:** 1

**Contrato do schema** (spec, decisões 6, 7, 10):
- `payouts(id, bureau_id, cutoff_at, amount, status, created_by, created_at, paid_at, paid_by, receipt_object_key, receipt_mime, receipt_sha256)`; `status` em `open | paid | cancelled`; CHECK `amount > 0`; CHECK: `paid` exige as três colunas de comprovante preenchidas.
- `payout_items(payout_id, entry_id unique)`: `entry_id` referencia `bureau_payable_entries` do tipo `accrual` ou `reversal`. A unicidade garante que um lançamento entra em um único repasse.
- Lançamento `payout` (−) em `bureau_payable_entries` ao marcar como pago.
- Em `pix_charges`: `nfse_status` (`not_requested | pending | issued | failed`, padrão `not_requested`), `nfse_number`, `nfse_url`, `nfse_updated_at`, `nfse_attempts` inteiro. O `nfse_url` é a única coluna de NFS-e que a cobrança de cliente expõe ao cliente.

**Contrato das funções:**
- `create_payout(p_bureau_id uuid, p_cutoff_at timestamptz)` (só superadmin sem suporte): trava os lançamentos do Bureau até o corte que não estão em `payout_items`, soma, recusa soma `<= 0` com `nothing_to_pay`, insere `payouts` (`open`) e os itens. Devolve `(ok, reason, payout_id, amount)`. Duas chamadas concorrentes nunca compartilham um lançamento.
- `mark_payout_paid(p_payout_id uuid, p_object_key text, p_mime text, p_sha256 text)`: exige `open`; grava o comprovante, `paid_at`, `paid_by`, e insere o lançamento `payout` (−amount). Idempotente por `payout_id`; em `cancelled` devolve `invalid_state`.
- `cancel_payout(p_payout_id uuid)`: só `open`; apaga os itens (a única exclusão permitida, via função) e marca `cancelled`.
- `app_runtime` executa as três; nenhuma outra role escreve nas tabelas. O superadmin lê `payouts` e `payout_items` de qualquer Bureau sem sessão de suporte (exceção estreita); o `bureau_admin` lê os repasses do próprio Bureau.
- NFS-e: função `set_nfse_status(p_charge_id uuid, p_status text, p_number text, p_url text)` para o webhook (`EXECUTE` só para `app_webhook`, idempotente: não regride `issued` para `pending`). Função `request_nfse_retry(p_charge_id uuid)` (superadmin) só aceita `failed` e volta para `pending` incrementando `nfse_attempts`.

**Testes (casos mínimos):**
- `create_payout` junta só lançamentos não repassados até o corte; `nothing_to_pay` com soma `<= 0` e com lista vazia.
- `concurrent create_payout never shares an accrual` (duas transações).
- `mark_payout_paid` grava o lançamento `payout`; saldo a repassar cai; repetir não duplica; em `cancelled` devolve `invalid_state`; sem comprovante a CHECK falha.
- `cancel_payout` libera os itens; repasse `paid` não cancela; os itens liberados entram num novo repasse.
- Conciliação: acréscimos + estornos + pagamentos de repasse de um Bureau batem com o saldo a repassar.
- Isolamento: `bureau_admin` do Bureau A não lê repasse do Bureau B nem executa `create_payout`; `app_runtime` não faz INSERT/UPDATE direto.
- NFS-e: `set_nfse_status` só por `app_webhook`; `issued` não regride; `request_nfse_retry` só em `failed`.

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/payouts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 6: Repasse, comprovante e NFS-e (aplicação)

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/payouts/queries.ts`, `src/lib/payouts/queries.integration.test.ts`
- Create: `src/lib/payouts/receipt.ts`, `src/lib/payouts/receipt.test.ts`
- Create: `src/lib/validators/payouts.ts`, `src/actions/payouts.ts`, `src/actions/payouts.test.ts`
- Create: `src/app/api/payouts/[id]/receipt/route.ts`, `src/app/api/payouts/[id]/receipt/route.test.ts`
- Create: `src/lib/nfse/queries.ts`, `src/lib/nfse/queries.integration.test.ts`
- Create: `src/actions/nfse.ts`, `src/actions/nfse.test.ts`
- Modify: `src/lib/asaas/client.ts`, `src/lib/asaas/types.ts`, `src/lib/asaas/asaas.test.ts`
- Modify: `src/app/api/webhooks/asaas/route.ts`, `src/app/api/webhooks/asaas/route.test.ts`
- Create: `docs/operations/nfse.md`

**Depends-on:** 2, 5

**Contrato:**
- `payouts/queries.ts`: `createPayout(identity, { bureauId, cutoffAt })`, `markPayoutPaid(identity, { payoutId, receipt })`, `cancelPayout(identity, payoutId)`, `listPayouts(client, { bureauId?, status? })`, `getPayout(client, id)`. Traduzem o resultado da função SQL em `{ ok, ... } | { ok: false, reason }`.
- `receipt.ts` (serviço de upload, usa `src/lib/documents`): `storePayoutReceipt(file)` verifica tamanho (5 MB), magic bytes (PDF, PNG, JPEG; ignora o MIME declarado), grava em quarentena, varre com ClamAV (falha fechada: `ScannerUnavailableError` rejeita), confirma o objeto e devolve `{ objectKey, mime, sha256 }`; em qualquer falha remove a quarentena. Não registra nome nem conteúdo em log. `openPayoutReceipt(key)` abre o objeto para o download.
- Server Actions: `createPayoutAction`, `markPayoutPaidAction` (recebe `FormData` com o arquivo; sequência: autoriza → `storePayoutReceipt` → `markPayoutPaid`; se a função SQL falhar, remove o objeto), `cancelPayoutAction`. Todas exigem `payout:manage`; auditoria `payout.create|pay|cancel` com `bureau_id` alvo e sem dados do arquivo.
- Rota `GET /api/payouts/[id]/receipt`: sessão obrigatória; autoriza o superadmin (sem suporte) ou o `bureau_admin` do Bureau dono do repasse; repasse sem comprovante, de outro Bureau ou inexistente responde 404 (sem diferenciar); envia `Content-Type` salvo, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
- NFS-e: o adaptador ganha `scheduleInvoice({ paymentId, ... })` com driver real e fake (mesma escolha por `ASAAS_DRIVER`). Confira a documentação vigente do Asaas (agendamento de nota fiscal, `municipalServiceId`, nomes de evento e campos) e registre num comentário curto o que conferiu. O handler do webhook, depois de confirmado o pagamento, tenta agendar a nota **fora** da transação do crédito e chama `set_nfse_status` (`pending` ou `failed`); eventos de nota do Asaas chamam `set_nfse_status` (`issued` com número e URL, ou `failed`). Sem a configuração municipal (variáveis documentadas), registre `not_requested` e não chame o Asaas. A rota continua respondendo 200 nos mesmos casos do M3a; a falha da nota nunca vira 500.
- `nfse/queries.ts`: `listNfseFailures(client)` (cobranças com `failed`, sem `asaas_payment_id`). `retryNfseAction({ chargeId })`: `nfse:manage` → `request_nfse_retry` → reagendamento.
- `docs/operations/nfse.md`: variáveis, configuração municipal do Asaas, passo a passo para o contador, e o aviso de que o tratamento fiscal (D3) precisa de validação antes do deploy.

**Testes (casos mínimos):**
- `receipt upload rejects oversize file, wrong magic bytes (PNG renomeado .pdf), polyglot, and scanner failure; quarantine is cleaned in each case`.
- `download is tenant-scoped`: admin do Bureau B recebe 404 do repasse do Bureau A; `operator` e `client` recebem 404/403; superadmin em suporte não baixa; cabeçalhos de segurança presentes.
- Ações: zod rejeita `bureauId` inválido e corte no futuro distante; `bureau_admin` e `operator` não criam nem pagam repasse; pagar sem arquivo falha; falha SQL remove o objeto.
- `nfse failure and duplicate invoice events never change the wallet`: erro do Asaas ao agendar mantém o crédito; evento `issued` duplicado não altera nada; `issued` não regride.
- Sem configuração municipal: `not_requested` e nenhuma chamada ao Asaas.
- Webhook: evento de nota com token inválido → 401; sem `payment.id` → 200 sem escrita.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/payouts src/lib/nfse src/lib/asaas src/actions/payouts.test.ts src/actions/nfse.test.ts src/app/api` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 7: Telas de repasse e NFS-e

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/app/(dashboard)/settings/payouts/page.tsx`
- Create: `src/app/(superadmin)/superadmin/payouts/page.tsx`, `src/app/(superadmin)/superadmin/nfse/page.tsx`
- Create: `src/components/payouts/{PayableSummary,PayoutTable,CreatePayoutForm,MarkPaidForm}.tsx`
- Create: `src/components/superadmin/NfseFailuresTable.tsx`
- Modify: `src/components/superadmin/SuperadminNav.tsx`

**Depends-on:** 2, 6

**Contrato:**
- Invoque `/ui-ux-pro-max`. Siga as telas do M3a e `src/components/CLAUDE.md`.
- `/settings/payouts` (`payout:read`): valor a receber (`getPayableBalance`), repasses do Bureau com estado e link de download do comprovante quando `paid`, e o extrato de lançamentos por cursor (remonte a tabela com `key`). Somente leitura.
- `/superadmin/payouts` (`payout:manage`): seleção de Bureau e data de corte; prévia do valor; criar repasse; lista de repasses abertos e pagos; "Marcar como pago" com envio do comprovante (PDF, PNG ou JPEG até 5 MB, mensagem de erro clara por motivo); cancelar repasse aberto com confirmação.
- `/superadmin/nfse` (`nfse:manage`): lista de notas com falha, motivo curto, número de tentativas e botão "Tentar de novo".
- `SuperadminNav`: itens "Repasses" e "NFS-e".
- Esconda controles de gravação quando o superadmin está em sessão de suporte. Textos em pt-BR.

**Testes:** só lógica com ramo extraída (validação de arquivo no cliente: tamanho e extensão; decisão de mostrar controles). Verificação visual no navegador, ou declare que não fez.

- [ ] Implemente, rode `npm run lint && npm run type-check` e os testes das funções extraídas.
- [ ] Entregue: lista de `Files changed`.

---

## Critérios de pronto

Cada critério aponta para o teste que o prova (lista da spec).

- Reserva, captura e liberação por `order_ref` são idempotentes; cruzamentos devolvem `invalid_state` (Task 1, 2).
- Online debita `P` do cliente e grava `P − C`; balcão debita `C` do Bureau sem acréscimo; `P < C` é recusado (Task 1, 2).
- A carteira do cliente nunca fica negativa, nem sob concorrência (Task 1).
- A recarga do cliente credita só a carteira dele; valor local, duplicidade e pagamento tardio como no M3a (Task 3).
- O cliente A não lê a carteira, o extrato nem as cobranças do cliente B (Task 1, 3).
- `counter_payments` não aceita UPDATE de valor nem DELETE; a anulação exige motivo e é auditada (Task 1, 2).
- Um lançamento entra em um único repasse; pagar exige comprovante (Task 5, 6).
- O Bureau A não lê repasse nem lançamento do Bureau B; o `bureau_admin` não grava repasse (Task 1, 5, 6).
- A falha da NFS-e não impede o crédito e aparece na lista (Task 6).
- Conciliação das carteiras, acréscimos e repasses (Task 1, 5).
- `/portal/credits`, `/settings/counter-payments`, `/settings/payouts`, `/superadmin/payouts` e `/superadmin/nfse` funcionam (Task 4, 7; verificação visual).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da onda 4.
- (post-deploy) O contador valida o tratamento fiscal da NFS-e (D3) e a configuração municipal.
- (post-deploy) Valide o contrato real do Asaas para NFS-e (agendar, eventos, campos) com um pagamento de valor mínimo.
- (post-deploy) Confira as telas novas no navegador e o fluxo completo com Asaas real.

Cada item `(post-deploy)` vira um item "Post-deploy follow-up" no PR. Nenhum bloqueia o merge.

## Cobertura da spec

| Spec | Task |
|---|---|
| Decisão 1 (carteira do cliente) | 1, 2 |
| Decisão 2 (recarga do cliente) | 1, 3 |
| Decisão 3 (liquidação por pedido) | 1, 2 |
| Decisão 4 (valor a repassar) | 1, 2, 5 |
| Decisão 5 (balcão) | 1, 2, 4 |
| Decisão 6 (repasse) | 5, 6, 7 |
| Decisão 7 (NFS-e) | 5, 6, 7 |
| Decisão 8 (recibo e histórico) | 3, 4 |
| Decisões 9–12 (permissões, banco, auditoria, dinheiro) | 1, 2, 5, 6 |
| Telas | 4, 7 |
| Ajustes nas issues (#28, #27) | fora do código: ver abaixo |

## Ajustes nas issues (fora das tasks)

- #28: remover o critério "cartão" e criar a issue "Cartão e chargeback" no backlog.
- #27: manter aberta até o M6 ligar as funções ao pedido.
