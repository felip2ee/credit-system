# Compra em etapas — Plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development`. Ondas paralelas em `.claude/rules/08-parallel-subagent-driven-development.md`. Implementadores não commitam; o coordenador commita uma vez por tarefa, em ordem, com o HEAD capturado antes de cada commit.

**Goal:** o cliente compra em etapas. A primeira etapa é "só para você" ou "para uma empresa". Na empresa, o comprador lista a si mesmo, sócios e cônjuges, confirma a lista com o valor total e segue para a tela de pagamento. O portal fica mais denso, sem mexer no admin.

**Architecture:** o formulário único vira um assistente. O estado fica no pai (`ClientOrderForm`, com `react-hook-form`). Cada etapa é um componente filho. A lógica de passos fica em um helper puro com teste, como em `src/components/payments/checkout-steps.ts`. A densidade é uma classe de escopo `.portal-dense` no layout do portal, mais a variante Tailwind `dense:`, no mesmo padrão da variante `admin:`. `open_order` e as migrations não mudam.

**Tech Stack:** Next.js 14 (App Router), React, TypeScript, shadcn/ui, Tailwind, `react-hook-form` + zod, `pg` sem ORM, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-fluxo-cliente-final-design.md`, Parte 3. Depende dos Planos 1 e 2. Roda depois deles.

## Decisões e correções à spec

1. **Escopo da densidade: classe `.portal-dense` só em `src/app/(portal)/layout.tsx`, com a variante `dense:`.** Motivo: `.area-portal` também vale para `(auth)`, `(portal-onboarding)` e `public-shell`. Mudar essa classe vaza a densidade para a landing e o login. A variante `dense:` repete `admin:` (`tailwind.config.ts:134`) e cabe em `Card`, `Button` e `Input` sem duplicar componente. Variável CSS não serve: os cards têm `p-6` fixo. O admin não muda: ele nunca fica dentro de `.portal-dense`, e o portal exige `role = client`.
2. **A fonte base muda pouco.** `text-base` já é 16 px fixo. Só o texto sem classe herda os 18 px de `.area-portal`. Por isso o ganho vem de `p-4`, altura de botão e espaçamento.
3. **O alvo de toque do portal cai de 48 px para 44 px** (`h-12` vira `h-11`). A spec diz "mantêm 44 px", mas `docs/design.md:79-80` diz 48 px no portal. O piso do projeto é 44 px (`e2e/mobile.spec.ts`). `docs/design.md` é corrigido na T3.
4. **"Etapa 1 define `holderType` e `self`" está errado.** `holderType` vem da conta (`getMyHolderType`). A etapa 1 define só `productCode`. `self` sai de `isSelfOrder(productCode, holderType)`.
5. **O comprador entra como membro sem mudar `open_order`: sim, para conta PF.** Em `055_platform_pricing_commission.sql` (regra D12, `v_partner_is_buyer`), o e-mail da conta só vale para o sócio cujo CPF é o de um Titular do comprador. Então o comprador entra como sócio comum, com o próprio CPF e o próprio e-mail. A autorização dele segue a regra D10 (reusa autorização válida). Conta PJ ou sem Titular não pode: o CPF não é Titular da conta, e o servidor devolve `contact_is_buyer`. A tela esconde "Adicionar eu" nesses casos. A conta guarda só o CPF mascarado: o comprador digita o CPF dele.
6. **`MAX_PARTNERS` (20) conta o comprador.** Ele é uma linha da lista. A mensagem do cliente passa a dizer "pessoas".
7. **Nome de arquivo:** `order-steps.ts` já existe (passos do pedido pago: "Pedido feito"…). Os passos da compra ficam em `order-wizard-steps.ts`.
8. **Sem saldo na tela.** O Plano 2 tira a recarga prévia. O formulário perde `available`, o aviso "Saldo insuficiente" e o botão "Comprar créditos".
9. **Regra nova de servidor:** e-mail repetido entre as pessoas da lista é recusado ("cada um com e-mail próprio"). CPF repetido continua contando uma vez (`toPartners`).

## Global Constraints

- Texto de interface, erro e comentário em pt-BR. Identificadores em inglês. Inglês Técnico Simplificado, frases curtas (`AGENTS.md`).
- Importar com `@/`. Menos de 350 linhas por arquivo (`max-lines`, `warn`). Sem `console.log`.
- Zod valida toda entrada (`src/lib/validators/`). A action segue: `safeParse`, sessão, `hasPermission`, query, `revalidatePath`, retorno `{ error: string | null, id? }`.
- SQL parametrizado, `withUserTransaction`. Nenhuma migration nova neste plano. Nunca editar migration aplicada.
- CPF/CNPJ completo nunca em log, auditoria nem mensagem de erro. Usar a forma mascarada.
- Sem degradê. Cor só por token (`docs/design.md`). Estado = ícone + cor + texto.
- Alvo de toque mínimo de 44 px; 8 px entre alvos. Rótulo sempre visível. Botão só com ícone leva `aria-label` (`docs/design.md`).
- Teste só o que tem lógica (`.claude/rules/05-testing.md`). Componente só de apresentação não tem teste unitário. Cobertura por helper puro ou e2e.
- Reuso do padrão da recarga: helper puro de passos com teste, foco no título da etapa, estado no pai, "Voltar" sem perder dados.
- Commit convencional. Não fazer push.

## Review Focus

Cinco falhas que o teste unitário de uma tarefa sozinha não pega. O teste de cada uma fica na tarefa dona.

1. **A densidade vaza para fora do portal** (login, landing, admin). Teste: `e2e/density.spec.ts` (T3).
2. **Dado perdido ou velho entre etapas.** "Voltar" perde linhas; trocar a escolha deixa CNPJ e sócios na compra "só para você"; Enter numa etapa envia o pedido sem passar pela revisão; erro de validação deixa o usuário na etapa errada. Teste: `stepWithErrors` (T2) e os testes e2e "Voltar mantém", "trocar a escolha limpa" e "Enter avança" (T5).
3. **A lista da revisão difere do que o servidor cobra** (CPF repetido, linha incompleta, CPF igual ao CNPJ da empresa). Teste: `billablePartners` (T2) e e2e "revisão mostra o total" (T5).
4. **Comprador como membro.** E-mail próprio com CPF que não é o dele; conta PJ vendo o botão; dois e-mails iguais na lista. Teste: integração e `order.test.ts` (T1) e `canAddSelf` (T2).
5. **Alvo de toque menor que 44 px ou rolagem horizontal nas etapas novas**, em 360 px e a 200% de fonte. Teste: telas das etapas em `e2e/critical-screens.ts`, lidas por `e2e/mobile.spec.ts` (T5).

## Ondas

W1: T1 ‖ T2 ‖ T3 (arquivos disjuntos). W2: T4. W3: T5.

---

### T1: Regras de servidor da lista de pessoas (backend-specialist, sonnet)

**Files:**
- `src/lib/validators/order.ts`, `src/lib/validators/order.test.ts`
- `src/lib/orders/failure-messages.ts`
- `src/actions/orders-client.test.ts` (linha 194, texto de `contact_is_buyer`)
- `src/actions/portal.integration.test.ts`

**Depends-on:** Plano 2 (as asserções de estado e saldo do pedido mudam; esta tarefa não afirma nenhuma das duas).

**Interfaces:**
- `clientOrderSchema` (`superRefine`): e-mail repetido na lista (comparação com `trim` e minúsculas; e-mail vazio é ignorado) gera issue em `["partners", i, "email"]` na 2ª ocorrência em diante. Mensagem: `"Cada pessoa precisa de um e-mail próprio."`.
- `clientOrderSchema`: `partners.max(...)` passa a dizer `` `No máximo ${MAX_PARTNERS} pessoas.` ``. `counterOrderSchema` não muda.
- `CLIENT_ORDER_MESSAGES.contact_is_buyer = "Use um e-mail diferente do seu. O seu e-mail só vale na linha com o seu CPF."`. `STAFF_ORDER_MESSAGES` e `UPDATE_CONTACT_MESSAGES` não mudam.

**Steps:**
- [ ] Em `order.test.ts`, escrever `refuses two partners with the same e-mail, ignoring case and spaces` (esperar `success: false`, issue em `["partners", 1, "email"]` com a mensagem acima) e `accepts the same CPF twice and counts one partner` (esperar `success: true` e `partners` com 1 item). Escrever `names the people limit in the message` (21 linhas: issue "No máximo 20 pessoas."). Rodar `npx vitest run src/lib/validators/order.test.ts` e ver falhar.
- [ ] Implementar o `superRefine` e a mensagem. Rodar o mesmo comando e ver passar.
- [ ] Em `orders-client.test.ts:194`, trocar o texto esperado de `contact_is_buyer`. Rodar `npx vitest run src/actions/orders-client.test.ts src/actions/orders.test.ts` (o teste do balcão não pode mudar).
- [ ] Em `portal.integration.test.ts`, no `describe("client orders through the portal actions")`, escrever três testes e ver falharem onde faltar (requer Postgres de `docker-compose.dev.yml`):
  - `the buyer enters as a member: own valid CPF and own e-mail as a partner opens the order`. Preparar: `update holders set document = <CPF válido> where client_profile_id = <cliente>`; ler o e-mail da conta em `profiles`. Enviar empresa com `partners: [{ document: <CPF do comprador>, name, email: <e-mail da conta> }, partner()]`. Esperar `error: null`; 3 linhas em `consultations` do pedido; 3 linhas `pending` em `scr_authorizations`, uma com `lower(email)` igual ao da conta; `audit_logs.metadata->>'self_member' = 'true'`. Não afirmar estado nem saldo.
  - `the buyer e-mail on a CPF that is not the buyer's is refused with the contact_is_buyer message and opens nothing`.
  - `an account with a PJ holder cannot add itself as a partner with its own e-mail` (trocar `type` e `document` do Titular para PJ/CNPJ válido na mesma `update`). Esperar a mensagem de `contact_is_buyer` e nenhum pedido. Este teste prova a regra de `canAddSelf` (T2).
- [ ] Rodar `npx vitest run src/actions/portal.integration.test.ts`. Corrigir só o que for desta tarefa. Rodar `npm run type-check` e `npm run lint`.
- [ ] Commit (coordenador): `feat(pedido): e-mail próprio por pessoa e limite em pessoas`.

---

### T2: Helpers puros do assistente (frontend-specialist, sonnet)

**Files:**
- `src/components/orders/order-wizard-steps.ts` (novo), `src/components/orders/order-wizard-steps.test.ts` (novo)
- `src/components/orders/order-rules.ts`, `src/components/orders/order-rules.test.ts`

**Depends-on:** nenhuma.

**Interfaces:**
```ts
// order-wizard-steps.ts
import type { HolderType } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";

export type OrderStep = "choice" | "subject" | "people" | "review";
export type OrderFormField = "subject" | "contactEmail" | "partners" | "declarationAccepted";

// Valores como o usuário digita (moveu de client-order-form.tsx).
export interface OrderFormValues {
	productCode: OrderProductCode;
	self: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
	partners: { name: string; document: string; email: string }[];
	declarationAccepted: boolean;
}

export function orderStepsFor(productCode: OrderProductCode, holderType: HolderType): OrderStep[];
export function orderStepTitle(step: OrderStep, productCode: OrderProductCode): string;
export const ORDER_STEP_FIELDS: Record<OrderStep, readonly OrderFormField[]>;
// Primeira etapa do caminho que tem erro; null se nenhum campo com erro pertence ao caminho.
export function stepWithErrors(steps: readonly OrderStep[], errorFields: readonly string[]): OrderStep | null;
```
```ts
// order-rules.ts (acréscimos; `productLabel` fica até a T4 removê-lo)
export function billablePartners<T extends { document?: string }>(partners: T[], companyDocument?: string): T[];
export function canAddSelf(holderType: HolderType): boolean;
export function hasBuyerRow(partners: { email?: string }[], buyerEmail: string): boolean;
export function choiceTitle(productCode: OrderProductCode, holderType: HolderType): string;
export function reviewActionLabel(totalCents: number): string;
```
Regras:
- Caminho: própria = `["choice", "review"]`; `dossie_pf` de conta PJ = `["choice", "subject", "review"]`; `dossie_empresarial` = `["choice", "subject", "people", "review"]`.
- Títulos: `choice` "Para quem é a pesquisa?"; `subject` "Dados da empresa" (empresarial) ou "Dados do responsável"; `people` "Pessoas da empresa"; `review` "Revise o pedido".
- `ORDER_STEP_FIELDS`: `choice: []`, `subject: ["subject", "contactEmail"]`, `people: ["partners"]`, `review: []`.
- `billablePartners`: mantém a 1ª linha de cada CPF completo e distinto, diferente do documento da empresa, na ordem original. `countBillablePartners` passa a usar `billablePartners(...).length`.
- `canAddSelf`: `holderType === "PF"`.
- `hasBuyerRow`: compara e-mail com `trim` e minúsculas; e-mail vazio nunca casa.
- `choiceTitle`: `dossie_pf` própria = "Só para você"; `dossie_pf` de conta PJ = "Para o responsável da empresa"; `dossie_empresarial` = "Para uma empresa".
- `reviewActionLabel`: `0` = "Confirmar pedido"; maior que 0 = "Ir para o pagamento".

**Steps:**
- [ ] Escrever `order-wizard-steps.test.ts` (ver falhar com `npx vitest run src/components/orders/order-wizard-steps.test.ts`):
  - `própria de conta PF ou sem Titular tem 2 etapas: choice e review`
  - `dossie_pf de conta PJ pede o responsável: choice, subject, review`
  - `empresarial tem 4 etapas em qualquer conta`
  - `título de subject muda entre empresa e responsável`
  - `stepWithErrors devolve a primeira etapa com erro, ignora campo fora do caminho e devolve null sem erro` (ex.: caminho própria + erro em `"partners"` → `null`; caminho empresarial + `["partners", "subject"]` → `"subject"`)
- [ ] Em `order-rules.test.ts`, acrescentar `choiceTitle` (3 casos acima) sem tirar os testes de `productLabel`, e acrescentar: `billablePartners descarta linha incompleta, CPF repetido e CPF igual ao da empresa, e mantém a ordem`; `canAddSelf só para conta PF`; `hasBuyerRow ignora caixa e espaço e nunca casa e-mail vazio`; `reviewActionLabel muda com valor zero`. Os testes atuais de `countBillablePartners` seguem passando.
- [ ] Implementar com as assinaturas exatas. Não remover `productLabel` (o `product-picker.tsx` ainda o usa até a T4). Rodar `npx vitest run src/components/orders` e `npm run type-check`.
- [ ] Commit (coordenador): `feat(pedido): passos e regras puras da compra em etapas`.

---

### T3: Densidade do portal (frontend-specialist, sonnet)

**Files:**
- `tailwind.config.ts`, `src/app/globals.css`
- `src/app/(portal)/layout.tsx`
- `src/components/ui/card.tsx`, `src/components/ui/button.tsx`, `src/components/ui/input.tsx`, `src/components/layout/page-header.tsx`, e `select.tsx` se tiver `h-12`
- páginas de `src/app/(portal)/portal/**/page.tsx`, exceto `pesquisas/nova/page.tsx` (dona: T4)
- `docs/design.md`
- `e2e/density.spec.ts` (novo)

Não tocar em `src/components/orders/*` (dono: T4).

**Depends-on:** nenhuma.

**Interfaces (forma exata):**
```ts
// tailwind.config.ts, ao lado do plugin `admin:`
// Variante `dense:` aplica a classe só dentro de `.portal-dense` (layout do portal do cliente), em qualquer largura.
plugin(({ addVariant }) => addVariant("dense", ".portal-dense &")),
```
```css
/* globals.css, logo depois de `.area-portal` */
.area-portal.portal-dense { font-size: 1rem; }
```
- `(portal)/layout.tsx`: `className="area-portal portal-dense ..."`; `main` com `dense:py-4`.
- `Card`: `CardHeader` ganha `dense:p-4 dense:space-y-1`; `CardContent` e `CardFooter` ganham `dense:p-4 dense:pt-0` (o `pt-0` repetido é obrigatório: a variante vem depois no CSS); `CardTitle` ganha `dense:text-lg`.
- `Button`: `default` `dense:h-11 dense:px-5`; `lg` `dense:h-12 dense:px-6`; `icon` `dense:h-11 dense:w-11`. `sm` já é `h-11`.
- `Input` (e `Select`, se `h-12`): `dense:h-11`.
- `PageHeader`: `dense:mb-4`.
- Páginas do portal: `space-y-6` vira `space-y-4` (10 arquivos, 11 ocorrências: `afiliacao`, `afiliacao/saque`, `credits`, `credits/receipts/[id]`, `notificacoes`, início, `perfil`, `pesquisas`, `pesquisas/[id]`).
- `docs/design.md`: base 18 px só nas páginas públicas e de auth (`.area-portal`); 16 px no portal logado (`.portal-dense`) e nos painéis; alvo de toque 48 px nas páginas públicas e 44 px no portal logado e nos painéis; uma linha sobre a variante `dense:` ao lado da `admin:`.

**Steps:**
- [ ] Escrever `e2e/density.spec.ts` e ver falhar (`npm run test:e2e -- e2e/density.spec.ts`):
  - `portal: a base é 16 px e o layout tem .portal-dense` (cliente em `/portal`: `getComputedStyle(.area-portal).fontSize === "16px"`).
  - `portal: o padding do primeiro CardContent é 16 px` (`[class*="dense:p-4"]`, em 360 px).
  - `login e landing mantêm 18 px` (sem sessão, `/login`).
  - `admin não recebe a densidade` (staff em 360 px, `/`: `document.querySelector(".portal-dense")` é `null` e o primeiro `[class*="dense:p-4"]` mede 24 px de padding).
- [ ] Implementar. Rodar o e2e novo, `e2e/mobile.spec.ts` e `e2e/a11y.spec.ts` (alvo de 44 px e contraste não podem piorar).
- [ ] Limite conhecido, a registrar no `docs/design.md`: diálogos e toasts do Radix renderizam em `body`, fora de `.portal-dense`. Ficam no tamanho normal.
- [ ] Rodar `npm run lint` e `npm run type-check`.
- [ ] Commit (coordenador): `feat(portal): densidade do portal com a variante dense`.

---

### T4: Assistente de compra (frontend-specialist, sonnet)

**Files:**
- `src/components/orders/client-order-form.tsx` (vira o pai; meta: menos de 220 linhas)
- `src/components/orders/order-step-subject.tsx`, `src/components/orders/order-step-people.tsx`, `src/components/orders/order-step-review.tsx` (novos)
- `src/components/orders/product-picker.tsx`, `src/components/orders/order-price-summary.tsx`, `src/components/orders/research-intro.tsx`
- `src/components/orders/order-rules.ts`, `src/components/orders/order-rules.test.ts` (só remover `productLabel` e os testes dele)
- `src/app/(portal)/portal/pesquisas/nova/page.tsx`
- `docs/architecture.md` (só se citar `client-order-form`)

**Depends-on:** T1, T2, Plano 2 (rota `/portal/pesquisas/[id]/pagar` e pedido em `awaiting_payment`). Se o Plano 2 expuser outro destino, ajustar só `onSubmit`.

**Interfaces:**
```ts
// client-order-form.tsx
export interface ClientOrderProduct extends ProductPrices { name: string }
interface ClientOrderFormProps {
	products: ClientOrderProduct[];
	holderType: HolderType;
	selfDocumentMasked: string | null;        // CPF mascarado da conta, para a dica
	buyer: { name: string; email: string };   // de getRequiredSession(): session.name, session.email
	declaration: { version: number; title: string; bodyMd: string };
}
export function ClientOrderForm(props: ClientOrderFormProps): JSX.Element; // sem `available`

// order-step-subject.tsx (usa useFormContext<OrderFormValues>())
export function SubjectStep(props: { productCode: OrderProductCode }): JSX.Element;

// order-step-people.tsx
export interface PeopleStepProps {
	fields: { id: string }[];                 // de useFieldArray, que fica NO PAI
	onAdd: (row?: Partial<OrderFormValues["partners"][number]>) => void;
	onRemove: (index: number) => void;
	canAddSelf: boolean;                      // canAddSelf(holderType) && !hasBuyerRow(...)
	buyer: { name: string; email: string };
	selfDocumentMasked: string | null;
}
export function PeopleStep(props: PeopleStepProps): JSX.Element;

// order-step-review.tsx
export interface ReviewStepProps {
	product: ClientOrderProduct;
	productCode: OrderProductCode;
	subject: { name: string; document: string } | null;   // null na própria
	people: OrderFormValues["partners"];                    // já passada por billablePartners
	breakdown: OrderPriceBreakdown | null;
	coupon: ReturnType<typeof useCoupon>;
	totalCents: number;
	hasMembers: boolean;
	declaration: ClientOrderFormProps["declaration"];
	serverError: string | null;
}
export function ReviewStep(props: ReviewStepProps): JSX.Element;
```
Textos exatos (a T5 usa estes nomes):
- Etapa 1: `ProductPicker` mostra `choiceTitle(...)` em negrito e o nome do produto em texto pequeno. Botão "Continuar".
- Subject: rótulos "CNPJ da empresa" / "CPF do responsável", "Razão social" / "Nome do responsável", "E-mail do responsável" (iguais aos de hoje).
- People: botão "Adicionar pessoa"; botão "Adicionar eu" (só com `canAddSelf`; preenche e-mail e nome da conta; o CPF fica vazio); dica "Sócios e cônjuges entram como pessoas comuns. Cada um autoriza pelo próprio e-mail. Até 20 pessoas."; por linha: "Nome da pessoa N", "CPF da pessoa N", "E-mail da pessoa N", botão "Remover pessoa N" (`aria-label`).
- Review: título "Revise o pedido"; lista de pessoas (nome, CPF mascarado, e-mail); `OrderPriceSummary` (agora "Pessoas: n × valor"); `CouponField`; total; declaração com "Li e concordo com a declaração acima." (só `hasMembers`); botão final com `reviewActionLabel(totalCents)`.
- Navegação: "Etapa N de M" e `<h2 tabIndex={-1}>` com o título (o foco vai ao título a cada troca, não na abertura); botões "Voltar" e "Continuar" em `flex flex-col-reverse gap-2 sm:flex-row sm:justify-end`.
- `ResearchIntro`: trocar a linha "O valor sai do seu saldo só quando a consulta roda." por "Você paga por Pix antes de a consulta rodar."

**Regras do pai:**
- `useForm` + `FormProvider`; `useFieldArray` e `step` no pai. `goNext` roda `trigger([...ORDER_STEP_FIELDS[step]])` (etapa sem campo avança direto) e só então `setStep(steps[i + 1])`.
- `<form onSubmit>`: fora da última etapa, o Enter chama `goNext` (nunca envia o pedido).
- `handleSubmit(onSubmit, onInvalid)`: `onInvalid` volta para `stepWithErrors(steps, Object.keys(errors))`.
- O `reset` ao trocar `productCode` continua (descarta empresa, pessoas e declaração). "Voltar" nunca chama `reset`.
- `onSubmit`: `openClientOrderAction({ ...getValues(), declarationVersion, couponCode })`; com sucesso, `router.push(\`/portal/pesquisas/${id}/pagar\`)`. Remover saldo, `insufficient` e "Comprar créditos".
- Página: remover `getClientWallet` e `available`; passar `buyer={{ name: session.name, email: session.email }}`; `space-y-4`.

**Steps:**
- [ ] Sem teste unitário novo (apresentação e cola; o comportamento é coberto por T2 e T5). Antes de editar, rodar `npx vitest run src/components/orders` para ver a base verde.
- [ ] Implementar na ordem: `SubjectStep`, `PeopleStep`, `ReviewStep`, pai, página, `ProductPicker`, `OrderPriceSummary` ("Pessoas"), `ResearchIntro`. Remover `productLabel` e os testes dele.
- [ ] Rodar `npm run type-check`, `npm run lint` e `npx vitest run src/components/orders src/actions`. Corrigir testes que citam texto antigo.
- [ ] Verificação manual curta: `npm run dev`, abrir `/portal/pesquisas/nova` em 360 px, andar pelas 3 trilhas (própria, empresa, responsável).
- [ ] Commit (coordenador): `feat(pedido): compra em etapas com lista de pessoas e revisão`.

---

### T5: e2e da compra em etapas (qa-automation-engineer, sonnet)

**Files:**
- `e2e/fixtures.ts` (`openOrder`)
- `e2e/portal-order.spec.ts`
- `e2e/critical-screens.ts`

**Depends-on:** T3, T4, Plano 2 (o fim de `openOrder` e as asserções de saldo são do Plano 2; esta tarefa troca só o preenchimento).

**Interfaces:**
```ts
// e2e/fixtures.ts
export async function openOrder(page: Page): Promise<string>; // devolve o id do pedido, lido de /portal/pesquisas/<id>/pagar
```
```ts
// e2e/critical-screens.ts: três telas novas na lista SCREENS (auth: "client")
// "portal: nova pesquisa, dados da empresa" | "..., pessoas" | "..., revisão"
```
Dados do e2e: o Titular do cliente semeado tem CPF sem dígitos válidos (`src/test/seed.ts`). Por isso o e2e não envia "Adicionar eu". Esse envio é coberto pela integração da T1.

**Steps:**
- [ ] Reescrever `openOrder`: `goto("/portal/pesquisas/nova")`; marcar o radio "Para uma empresa"; "Continuar"; preencher "CNPJ da empresa", "Razão social", "E-mail do responsável"; "Continuar"; "Adicionar pessoa"; preencher "Nome da pessoa 1", "CPF da pessoa 1", "E-mail da pessoa 1"; "Continuar"; ver o título "Revise o pedido"; botão "Ir para o pagamento" desabilitado; marcar "Li e concordo com a declaração acima."; botão habilitado; clicar; esperar a URL `/portal/pesquisas/<uuid>/pagar`.
- [ ] Em `portal-order.spec.ts`, escrever e ver falhar (`npm run test:e2e -- e2e/portal-order.spec.ts`), depois passar:
  - `wizard: "Voltar" mantém os dados` (empresa preenchida, pessoas com 1 linha; volta duas vezes; os campos seguem preenchidos).
  - `wizard: trocar a escolha limpa os dados` (preenche a empresa, volta à etapa 1, escolhe "Só para você", vai à revisão sem dados de empresa; volta, escolhe "Para uma empresa", o CNPJ está vazio).
  - `wizard: Enter numa etapa avança e não envia` (Enter no campo "CNPJ da empresa" leva a "Pessoas da empresa" ou mostra o erro do campo; nunca chega à revisão).
  - `wizard: o foco vai ao título da etapa` (`getByRole("heading", { name: "Dados da empresa" })` com `toBeFocused()` depois de "Continuar").
  - `wizard: e-mail repetido bloqueia "Continuar" na etapa de pessoas` (mensagem "Cada pessoa precisa de um e-mail próprio.").
  - `wizard: a revisão mostra a lista e o total` (2 pessoas com o mesmo CPF: a lista mostra 1 e o total é `E2E.salePrice + 1 × E2E.salePricePerPartner`; este é o teste da falha 3).
  - `wizard: "só para você" tem duas etapas e não pede declaração` (cliente PF semeado: "Etapa 1 de 2", revisão sem a caixa de declaração, botão "Ir para o pagamento" habilitado).
  - `wizard: "Adicionar eu" preenche o e-mail da conta e some depois de usado` (cliente PF semeado: linha 1 com `E2E.client.email`, CPF vazio, botão "Adicionar eu" desabilitado ou ausente).
- [ ] Acrescentar as três telas em `critical-screens.ts`. Rodar `npm run test:e2e -- e2e/mobile.spec.ts e2e/a11y.spec.ts`: sem alvo abaixo de 44 px, sem rolagem horizontal, também a 200% de fonte (falha 5).
- [ ] Rodar o e2e completo do portal: `npm run test:e2e -- e2e/portal-order.spec.ts e2e/density.spec.ts`. Qualquer outro spec que use `openOrder` deve seguir verde.
- [ ] Commit (coordenador): `test(e2e): compra em etapas do portal`.

---

## Verificação ao fim (por tarefa, não por fase)

Cada tarefa termina com os testes dela verdes. Ao fechar a issue: `npm run check` e `npm run verify:release`; depois `/code-review` e o loop normal do PR. O PR mantém `Closes #n`.

## Post-deploy follow-up

- (post-deploy) Conta PF real com autorização SCR ainda válida: o comprador na lista não recebe novo pedido de autorização (regra D10).
- (post-deploy) Conferir a densidade em um celular real de 360 px de largura, com texto grande do sistema.
- (post-deploy) Conferir que `/portal/pesquisas/<id>/pagar` abre para pedido novo e redireciona ao pedido quando o total é zero (contrato do Plano 2).

## Perguntas ao dono do produto

1. Empresa sem nenhuma pessoa na lista pode seguir para pagar? Hoje pode (só o responsável autoriza). O plano mantém.
2. Conta PJ: "só para você" vira "Para o responsável da empresa" e pede nome, CPF e e-mail do responsável. Está certo?
3. O comprador digita o próprio CPF ao se adicionar (a conta guarda só a forma mascarada). Está bom?

## Auto-revisão

- Cobertura da Parte 3: etapa 1 (T2, T4), empresa (T4), pessoas com e-mail próprio (T1, T4), revisão com total (T4, T5), caminho ao pagamento (T4, T5), limite `MAX_PARTNERS` (T1, T4), comprador como membro (T1, T2, T4), densidade e alvo de 44 px (T3, T5), divisão do arquivo de 345 linhas (T4).
- Nomes: `OrderStep`, `orderStepsFor`, `stepWithErrors`, `billablePartners`, `canAddSelf`, `hasBuyerRow`, `choiceTitle`, `reviewActionLabel`, `dense:`, `.portal-dense` são iguais em todas as tarefas.
- Proporção: 5 tarefas, 3 em paralelo na primeira onda. Sem tarefa de revisão, gate final nem simulação.
