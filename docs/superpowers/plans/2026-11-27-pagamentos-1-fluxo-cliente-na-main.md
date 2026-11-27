# Pagamentos, entrega 1: fluxo do cliente na `main` — Plano de implementação

> **Para agentes:** use superpowers:subagent-driven-development com as regras de "Lean delivery" do `CLAUDE.md` raiz e `.claude/rules/08-parallel-subagent-driven-development.md`. Passos usam `- [ ]`. Implementadores não fazem commit: o coordenador commita.

**Goal:** O trabalho das partes 2, 3 e 4 do fluxo do cliente (PIX por pedido, compra em etapas, correção de e-mail da autorização, migrações 063-069) chega à `main` atual. O visual da `main` (PRs #116-#120) vence. O comportamento do fluxo continua. Nenhuma regra de negócio nova.

**Architecture:** Branch nova a partir de `origin/feat/fluxo-4-autorizacao-editar-email`. Um merge de `origin/main` nessa branch resolve os conflitos uma vez. Depois, commits normais trazem o comportamento do assistente de compra do fluxo para o assistente da `main`, ajustam o e2e e atualizam o `PRODUCT.md`.

**Tech Stack:** Next.js 14 (App Router), TypeScript, zod, react-hook-form, `pg` sem ORM, PostgreSQL com RLS, vitest, Playwright, Tailwind, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-27-pagamentos-asaas-cartao-design.md`, seção "Entrega 1". Os planos de origem são `docs/superpowers/plans/2026-11-26-fluxo-cliente-{2,3,4}-*.md`.

## Fatos verificados (`git fetch` em 2026-11-27)

| Fato | Evidência |
|---|---|
| `origin/feat/fluxo-4-autorizacao-editar-email` (`cedd29b`) tem todo o trabalho que falta. | 32 commits à frente da `main`, 22 atrás. Base `d11f903` (fluxo-1), que já está na `main`. |
| `fluxo-3` tem a mesma árvore da `fluxo-4`. `fluxo-2` é um subconjunto. `fluxo-1` está inteira na `main`. | `git diff origin/feat/fluxo-4… origin/feat/fluxo-3…` vazio. Os únicos commits fora da `fluxo-4` são os merges dos PRs #113 e #114, sem resolução manual (`git show --remerge-diff` vazio). |
| `origin/feat/recarga-por-etapas` não tem trabalho próprio fora da `fluxo-4` e da `main`. | Só os merges dos PRs #111 e #112, ambos limpos. A base `b0b8c0f` está na `main`. |
| Migrações sem colisão. | `main` termina em `062_client_register_no_email.sql`. O fluxo adiciona 063-069. A entrega 2 (`feat/afiliado-bureaus`) usa 070-086. |
| CI. | O merge traz, sem conflito, duas variáveis no passo E2E do `ci.yml`: `DATABASE_WEBHOOK_URL` (role `app_webhook`) e `ASAAS_WEBHOOK_TOKEN` (token de teste). Produção não precisa de variável nova: `DATABASE_WEBHOOK_URL_FILE` e o token do webhook já existem na `main`. |
| PRs abertos #122-#134 e `origin/integra/*` não afetam a ordem. | Eles apontam para `integra/portal-ux` e `integra/bureau-ux`, não para a `main`. Os commits deles fora da `main` só tocam um arquivo do fluxo: `e2e/affiliate.spec.ts` (PR #134). |
| A `fluxo-4` está em uso em outra worktree. | `~/orca/workspaces/credit-system/recarga-por-etapas`. Por isso este plano usa uma branch nova. |

## Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| Merge ou rebase | Merge de `origin/main` na branch nova. Sem rebase. | O rebase reaplica 32 commits, três deles em `client-order-form.tsx`, e repete os mesmos conflitos várias vezes. Os commits do fluxo já estão em PRs fechados (#112-#114); reescrever o histórico perde essa ligação. O merge resolve cada conflito uma vez. |
| Base da branch | `origin/feat/fluxo-4-autorizacao-editar-email`. No merge, `--ours` é o fluxo e `--theirs` é a `main`. | Mantém o histórico dos PRs. O PR final aponta para a `main`. |
| Assistente de compra | O assistente da `main` (#116) fica: `order-wizard-steps.ts`, `subject-step.tsx`, `partners-step.tsx`, `review-step.tsx`, `ScreenHeader`, guarda de clique, voltar e fechar. As regras do assistente do fluxo vão para ele (T2). Os componentes do fluxo (`order-step-*.tsx`) saem. | Os dois lados criaram um assistente em etapas para a mesma tela. O visual da `main` vence. As regras do fluxo continuam. |
| Densidade do portal | Sai a variante `dense:`, a classe `.portal-dense` e `e2e/density.spec.ts`. Vale a escala da `main` (#117): base de 18 px, `Button` `h-11`. | O visual da `main` vence. As duas densidades juntas compactariam duas vezes. |
| Saldo no pedido | O assistente não bloqueia mais por saldo insuficiente. O pedido sem saldo vai para `/portal/pesquisas/<id>/pagar`. | É a regra do fluxo 2 (`placeOrder` usa o saldo ou grava a cotação do PIX). A `main` ainda mostra "Saldo insuficiente… Compre créditos". |
| Pedido "só para você" | Fica a etapa "Dados" da `main` (3 etapas). | Estrutura de etapas é visual. Ver "Decisões do dono". |
| Nome da etapa da lista | "Pessoas" (título "Pessoas da empresa"), não "Sócios". | A lista do fluxo inclui o comprador e o cônjuge, e as mensagens do validador já dizem "pessoa". Ver "Decisões do dono". |

## Global Constraints

- Nenhuma regra de negócio nova. Nenhuma migração nova. Migração aplicada não muda.
- Textos de interface, erros e comentários em pt-BR. Import com `@/`.
- Mutação e auditoria na mesma transação; SQL parametrizado; nenhum `PoolClient` sai do módulo de queries (já vale no código do fluxo; não mudar).
- Testes de integração rodam num banco novo e vazio, com nome terminado em `_test` (por exemplo `credit_system_e1_test`, criado como em `docker/postgres/dev-init/003-test-database.sh`), por `TEST_DATABASE_URL` e `TEST_DATABASE_OWNER_URL`. Não use `credit_system` nem `credit_system_test`: outro agente faz testes de navegador.
- O e2e local usa banco e porta próprios (`DATABASE_URL`, `PLAYWRIGHT_BASE_URL`). Se não houver como isolar, o e2e roda na CI do PR.
- Implementadores usam `model: sonnet` (T4: `haiku`). Nunca `opus`. Não fazem commit nem push.
- Push, PR, merge na `main` e deploy precisam de autorização do dono.

## Review Focus

Revisão única no fim da entrega (`/code-review`, `code-reviewer`, `security-reviewer`). Pontos de risco, cada um com o teste que o cobre:

1. **Pedido sem saldo não chega ao PIX.** T2: teste de `canLeaveStep`/revisão sem bloqueio por saldo; T3: `e2e/portal-order-pix.spec.ts` ("client without balance pays the order by PIX…").
2. **E-mail repetido na lista passa da etapa e só falha no envio.** T2: `canLeaveStep("partners")` recusa e-mail repetido; T3: e2e "e-mail repetido bloqueia Continuar".
3. **Migrações 063-069 sobre a `main` num banco novo.** T1: `npm run check` com banco `_test` novo.
4. **Resto de densidade dupla ou de componente órfão.** T1: `git grep -n "dense:\|portal-dense\|order-step-"` vazio.
5. **Correção de e-mail da autorização some na página do pedido.** T1: resolução de `pesquisas/[id]/page.tsx`; T3: `e2e/portal-order.spec.ts` e o caso de autorizações.

## Estrutura de arquivos

| Arquivo | Ação | Tarefa |
|---|---|---|
| 21 arquivos em conflito (lista na T1) | resolver | T1 |
| `src/components/orders/order-rules.ts`, `order-rules.test.ts` | restaurar `productLabel` | T1 |
| `tailwind.config.ts`, `src/components/portal/account-menu.tsx` | tirar `dense` | T1 |
| `src/app/(portal)/portal/{afiliacao,credits,notificacoes,perfil,pesquisas}/page.tsx` | versão da `main` | T1 |
| `src/app/(portal)/portal/pesquisas/[id]/pagar/page.tsx` | visual da `main` | T1 |
| `src/components/orders/order-step-{people,review,subject}.tsx`, `e2e/density.spec.ts` | apagar | T1 |
| `src/components/orders/client-order-form.tsx`, `order-wizard-steps.ts`, `order-wizard-steps.test.ts`, `partners-step.tsx`, `review-step.tsx`, `subject-step.tsx` | editar | T2 |
| `src/app/(portal)/portal/pesquisas/nova/page.tsx` | editar | T2 |
| `src/lib/validators/order.ts`, `order.test.ts` | editar (helper de e-mail repetido) | T2 |
| `e2e/fixtures.ts`, `e2e/critical-screens.ts`, `e2e/portal-order-wizard.spec.ts`, `e2e/portal-order-pix.spec.ts` | editar | T3 |
| `PRODUCT.md` | editar | T4 |

Ondas: **W1** T1 (sozinha: o merge é serial). **W2** T2 e T4 em paralelo (arquivos disjuntos). **W3** T3. Commits na ordem T1 (commit de merge), T2, T4, T3.

---

### T1 — Branch nova e merge da `main` com todos os conflitos resolvidos

**Agente:** `frontend-specialist`, `model: sonnet`. **Depends-on:** none.

**Files:** os 21 arquivos em conflito abaixo; `src/components/orders/order-rules.ts`, `order-rules.test.ts`; `tailwind.config.ts`; `src/components/portal/account-menu.tsx`; `src/app/(portal)/portal/afiliacao/page.tsx`, `credits/page.tsx`, `notificacoes/page.tsx`, `perfil/page.tsx`, `pesquisas/page.tsx`, `pesquisas/[id]/pagar/page.tsx`; apagar `src/components/orders/order-step-people.tsx`, `order-step-review.tsx`, `order-step-subject.tsx`, `e2e/density.spec.ts`.

**Por que é uma tarefa só:** um merge com conflito não tem commit até o último arquivo ficar resolvido, e o type-check só roda com a árvore inteira sem marcadores. Por isso um especialista faz tudo, em série. O comportamento do assistente fica para a T2, depois do commit de merge.

Passos de git (o coordenador ou o implementador, sem commit):

```bash
git fetch origin
git worktree add ~/orca/workspaces/credit-system/fluxo-cliente-na-main \
  -b feat/fluxo-cliente-na-main origin/feat/fluxo-4-autorizacao-editar-email
cd ~/orca/workspaces/credit-system/fluxo-cliente-na-main
git merge --no-ff --no-commit origin/main   # 21 conflitos esperados
```

Copie para a worktree nova a spec e este plano (hoje sem commit na worktree `main`). Não copie o `package-lock.json` modificado da worktree `main`: a mudança não é desta entrega.

**Resolução por arquivo** (`ours` = fluxo, `theirs` = `main`):

| Arquivo | O que a `main` fez | O que o fluxo fez | Resolução |
|---|---|---|---|
| `src/components/ui/button.tsx`, `card.tsx`, `input.tsx`, `select.tsx` | Compactou os componentes base (#117) e restaurou classes do admin | Classes `dense:` | `theirs` |
| `src/app/globals.css` | Tema clássico único, especificidade dos blocos (#117, #120) | `.area-portal.portal-dense { font-size: 1rem }` | `theirs` |
| `src/components/layout/page-header.tsx` | Compactou o cabeçalho | `dense:` | `theirs` |
| `src/app/(portal)/layout.tsx` | Cabeçalho fixo (#119) | `portal-dense`, `dense:py-4`, CSS do BottomNav | `theirs`. O ajuste de `1c28e22` era só o `dense:pt-4` sobre o BottomNav; a `main` já tem `py-4 pb-24` e `scroll-mb`. |
| `src/app/(portal)/portal/page.tsx`, `afiliacao/saque/page.tsx`, `credits/receipts/[id]/page.tsx` | Cabeçalho, saque em etapas, recibo com voltar no topo | Só espaçamento de densidade | `theirs` |
| `docs/design.md` | Regras de densidade e tema da `main` | Parágrafo `dense:` e base de 16 px no portal | `theirs` |
| `src/components/orders/order-wizard-steps.ts`, `order-wizard-steps.test.ts` (add/add) | Assistente da `main`: `wizardSteps`, `canLeaveStep`, `hasTypedData` | Assistente do fluxo: `orderStepsFor`, `stepWithErrors` | `theirs` |
| `src/components/orders/client-order-form.tsx`, `product-picker.tsx`, `research-intro.tsx`, `src/app/(portal)/portal/pesquisas/nova/page.tsx` | Nova pesquisa em etapas (#116) | Compra em etapas e redirecionamento ao PIX | `theirs` nesta tarefa. A T2 traz o comportamento do fluxo. |
| `src/lib/validators/order.ts` | `export` em `subjectSchema`, `emailSchema`, `partnerSchema` | Textos "pessoa", e-mail repetido recusado, `updateMemberEmailSchema`, `resendMemberSchema`, `orderPixSchema` | União: os três `export` da `main` e tudo do fluxo |
| `src/app/(portal)/portal/pesquisas/[id]/page.tsx` | `ScreenHeader` com voltar, linha sem estouro (#119) | Link e estado do PIX do pedido, estorno, seção Autorizações com corrigir e-mail e reenviar | Estrutura e cabeçalho da `main`; todo o conteúdo do fluxo (PIX, estorno, `memberActionHint`, `MemberEmailActions`) |
| `e2e/fixtures.ts` | `openNewOrderAtStep` com títulos "Dados", "Sócios", "Revisar e confirmar" | `openOrder(page, { expectPayment })`, `CLIENT_NO_BALANCE_STATE`, token do webhook, passos do assistente do fluxo | União sem marcadores: helpers da `main` mais os helpers de PIX do fluxo. A T3 ajusta os passos. |
| `e2e/critical-screens.ts` | Telas do assistente da `main` | Telas do assistente do fluxo | União sem marcadores. A T3 ajusta. |

**Conflitos escondidos** (o git junta sem aviso, mas quebra):

- `order-rules.ts`: o fluxo removeu `productLabel`; `product-picker.tsx` e `review-step.tsx` da `main` usam a função. Restaure `productLabel` e o teste dela em `order-rules.test.ts`. Mantenha o resto do fluxo (`billablePartners`, `canAddSelf`, `hasBuyerRow`, `choiceTitle`, `reviewActionLabel`, `memberActionHint`, `shouldRestoreFocus`).
- `tailwind.config.ts`: remova o plugin `addVariant("dense", ".portal-dense &")`. Fica o da `main`.
- `account-menu.tsx`: remova `dense:h-14`.
- `afiliacao/page.tsx`, `credits/page.tsx`, `notificacoes/page.tsx`, `perfil/page.tsx`, `pesquisas/page.tsx`: o fluxo só mudou densidade (`5cc2c3c`). Use a versão da `main` (`git checkout origin/main -- <arquivo>`).
- `pesquisas/[id]/pagar/page.tsx` (novo no fluxo): tire as classes de densidade. Cabeçalho no padrão de subtela da `main` (`ScreenHeader` com voltar para `/portal/pesquisas/<id>`, como em `credits/receipts/[id]/page.tsx`). Comportamento sem mudança.
- `order-step-people.tsx`, `order-step-review.tsx`, `order-step-subject.tsx`, `e2e/density.spec.ts`: apague. Ficam órfãos. A T2 lê o comportamento deles em `origin/feat/fluxo-4-autorizacao-editar-email`.
- `order-members.tsx`, `order-price-summary.tsx`, `.github/workflows/ci.yml`, `docs/architecture.md`, `docs/operations/orders.md`, `db/migrations/CLAUDE.md`, `e2e/affiliate.spec.ts`: juntados sem conflito. Leia o resultado; corrija só o que quebrar.

**Gate da tarefa:**

- [ ] `git diff --name-only --diff-filter=U` vazio; `git grep -nE "^(<<<<<<<|>>>>>>>)" -- src e2e docs` vazio.
- [ ] `git grep -n "dense:\|portal-dense\|order-step-"` vazio em `src`, `e2e`, `tailwind.config.ts`, `docs/design.md`.
- [ ] `npm run lint`, `npm run type-check`.
- [ ] `npm run test` num banco `_test` novo e vazio (ver Global Constraints). O `pretest` aplica 001-069 do zero; as suítes `order-pix*.integration.test.ts`, `member-email.integration.test.ts` e `tick.integration.test.ts` passam.
- [ ] `npm run db:migrate:test`.

Coordenador: commit de merge `merge: main (redesenho do portal) no fluxo do cliente`, com o texto da tabela de resolução no corpo.

---

### T2 — Assistente de compra da `main` com as regras do fluxo

**Agente:** `frontend-specialist`, `model: sonnet`. **Depends-on:** T1.

**Files:** `src/components/orders/client-order-form.tsx`, `order-wizard-steps.ts`, `order-wizard-steps.test.ts`, `partners-step.tsx`, `review-step.tsx`, `subject-step.tsx`; `src/app/(portal)/portal/pesquisas/nova/page.tsx`; `src/lib/validators/order.ts`, `order.test.ts`.

**Fonte do comportamento:** `git show origin/feat/fluxo-4-autorizacao-editar-email:<caminho>` de `client-order-form.tsx`, `order-step-people.tsx`, `order-step-review.tsx`, `order-step-subject.tsx`, e o plano `2026-11-26-fluxo-cliente-3-compra-em-etapas.md`. Visual, etapas, cabeçalho, guarda de clique e confirmação de saída: os da `main`.

**Contrato:**

- `ClientOrderFormProps`: sai `available`; entra `buyer: { name: string; email: string }`. `nova/page.tsx` passa `buyer={{ name: session.name, email: session.email }}` e não lê mais a carteira (remova `getClientWallet` se ficar sem uso).
- Envio: `router.push(\`/portal/pesquisas/${result.id}${result.paymentRequired ? "/pagar" : ""}\`)`.
- Revisão: sem "Saldo disponível", sem o aviso "Saldo insuficiente…" e sem o botão de comprar créditos. O botão final fica ativo pela regra `canConfirmOrder` e mostra `reviewActionLabel(totalCents)`. A lista mostra `billablePartners(partners, subject.document)`.
- Etapa da lista: botão "Adicionar eu" quando `canAddSelf(holderType) && !hasBuyerRow(partners, buyer.email)`, que preenche nome e e-mail da conta (como `order-step-people.tsx`). "Adicionar pessoa" fica desabilitado no limite `MAX_PARTNERS`. Rótulo "Pessoas", título "Pessoas da empresa".
- Textos de `wizardSteps` que dizem "O valor só sai do saldo quando a consulta roda" passam a dizer o que o fluxo faz: sem saldo suficiente, o pagamento por PIX vem na tela seguinte. Use o texto do fluxo, sem regra nova.
- E-mail repetido: uma fonte só. Exporte de `src/lib/validators/order.ts`:

```ts
// Índices das linhas cujo e-mail (trim, minúsculas) já apareceu antes na lista. Linha sem e-mail não conta.
export function duplicateEmailIndexes(partners: readonly { email?: string }[]): number[];
```

  O `superRefine` de `clientOrderSchema` e `canLeaveStep("partners", state)` usam essa função. A mensagem continua "Cada pessoa precisa de um e-mail próprio.", no campo `partners.<i>.email`.

**Regras:** nenhuma regra nova; zod como fonte única das regras da etapa (padrão de `canLeaveStep` da `main`); texto em pt-BR; acessibilidade da `main` (foco no título da etapa, erro ligado por `aria-describedby`).

**Testes:**

- `order.test.ts`: `duplicateEmailIndexes` acha repetição com caixa e espaço diferentes; ignora linha sem e-mail; lista vazia devolve `[]`; CPF repetido com e-mails diferentes não é repetição.
- `order-wizard-steps.test.ts`: `canLeaveStep("partners")` recusa dois e-mails iguais; aceita lista vazia; aceita linhas distintas. `wizardSteps` não promete débito de saldo em nenhuma etapa.
- [ ] `npx vitest run src/components/orders src/lib/validators/order.test.ts src/actions/orders-client.test.ts`, `npm run lint`, `npm run type-check`.

---

### T3 — E2E do assistente e do PIX do pedido no visual da `main`

**Agente:** `qa-automation-engineer`, `model: sonnet`. **Depends-on:** T2.

**Files:** `e2e/fixtures.ts`, `e2e/critical-screens.ts`, `e2e/portal-order-wizard.spec.ts`, `e2e/portal-order-pix.spec.ts`.

**Contrato:**

- `fixtures.ts`: um helper só para andar no assistente (`openNewOrderAtStep`, títulos da `main` e "Pessoas da empresa"). `openOrder(page, { expectPayment?: boolean })` usa esse helper e, com `expectPayment`, espera a URL `/portal/pesquisas/<id>/pagar`. Remova os helpers do assistente do fluxo que ficarem sem uso.
- `critical-screens.ts`: sem tela duplicada; inclui a tela `/pagar` do pedido.
- `portal-order-wizard.spec.ts`: mantém estes casos do fluxo, com seletores da `main`: voltar mantém os dados; trocar a escolha limpa os dados; Enter não pula etapa; foco vai ao título da etapa; e-mail repetido bloqueia "Continuar"; a revisão mostra a lista e o total; "Adicionar eu" preenche o e-mail da conta e some depois de usado; limite desabilita "Adicionar pessoa"; comprador, sócio e cônjuge aparecem na revisão. O caso "só para você tem duas etapas" passa a verificar as etapas da `main` ("Para quem", "Dados", "Revisão") e a falta de declaração. Não repita casos que `e2e/portal-order.spec.ts` já cobre.
- `portal-order-pix.spec.ts`: só seletores, se mudarem.

**Gate da tarefa** (é também o critério de pronto da entrega):

- [ ] `npm run check` num banco `_test` novo e vazio.
- [ ] `npm run test:e2e` completo, com banco e porta próprios (ver Global Constraints). Se não houver como isolar do outro agente, o e2e roda na CI do PR, que já tem `DATABASE_WEBHOOK_URL` e `ASAAS_WEBHOOK_TOKEN` no passo E2E.

---

### T4 — `PRODUCT.md` com o fluxo do cliente

**Agente:** `documentation-writer`, `model: haiku`. **Depends-on:** T1.

**Files:** `PRODUCT.md`.

**Contrato:** um parágrafo curto, no estilo das outras entradas, que diz o que já está no código: o pedido online usa o saldo; sem saldo suficiente, o cliente paga o pedido por PIX e o pedido segue sozinho quando o webhook confirma; estorno do PIX cancela o pedido que ainda não rodou; a compra é em etapas; o cliente corrige o e-mail de quem autoriza o SCR e reenvia o pedido, com limite diário. Links para `docs/operations/orders.md` e para os planos `2026-11-26-fluxo-cliente-{2,3,4}`. Nenhuma regra nova. ASD-STE100, pt-BR.

**Teste:** nenhum (texto). O coordenador confere que cada frase tem uma migração ou um teste do fluxo que a sustenta.

---

## Post-deploy follow-up

Um item no corpo do PR, que não bloqueia o merge:

- (post-deploy) Um pedido real sem saldo paga por PIX no Asaas de produção, o webhook confirma e o pedido passa a `awaiting_authorization`. As migrações 063-069 rodam no deploy.

## Decisões do dono

1. **Pedido "só para você":** a `main` mostra 3 etapas (com "Dados" para conferir); o fluxo mostrava 2. O plano usa as 3 da `main`.
2. **Nome da etapa da lista:** o plano usa "Pessoas da empresa" (o fluxo), porque a lista tem comprador e cônjuge. A alternativa é "Sócios" (a `main`).
3. **Push, PR para a `main`, merge e deploy:** precisam de autorização.
4. **Branches antigas** (`feat/fluxo-1..4`, `feat/recarga-por-etapas` e a worktree `recarga-por-etapas`): ficam obsoletas depois do merge. Apagar precisa de autorização.
