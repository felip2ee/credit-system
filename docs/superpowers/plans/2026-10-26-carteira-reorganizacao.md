# Carteira: reorganização Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Follow "Lean delivery" and the parallel-wave rule in `CLAUDE.md` and `.claude/rules/08-parallel-subagent-driven-development.md`: implementers do not commit; the coordinator commits per task.

**Goal:** A Carteira do Bureau mostra Pedidos online, Balcão, Extrato total e A receber e saques, com retenção de 30 dias que bloqueia o repasse.

**Architecture:** Só exibição muda nas abas; a contabilidade (`capture_order`, carteiras) não muda. A retenção entra em `create_payout` (SQL) e numa configuração global do superadmin (tabela `settings`, mesmo padrão da carência de afiliados). A data de liberação é calculada na leitura: `created_at` do lançamento + prazo.

**Tech Stack:** Next.js 14 App Router, `pg` com SQL puro e `withUserTransaction`, zod, vitest, PostgreSQL com RLS.

**Spec:** `docs/superpowers/specs/2026-10-26-carteira-reorganizacao-design.md`

**Pré-requisito:** o commit da migração `034_push_notifications.sql` (outro agente) vem antes da Wave 1. Esta migração usa o número 035; a Task 5 pode usar 036.

## Global Constraints

- UI, erros e comentários em pt-BR, linguagem simples. Identificadores em inglês.
- Retenção: padrão 30 dias, chave `payable_retention_days` em `settings`, uma para todos os Bureaus, só o superadmin altera.
- Data de liberação = `bureau_payable_entries.created_at` + prazo. Calculada na leitura. Sem coluna nova.
- "Disponível para saque" e "Em liberação" nunca mostram valor abaixo de zero.
- A retenção bloqueia `create_payout` no banco. A tela e o pagamento usam o mesmo cálculo.
- Nenhum nome técnico (`reserve`, `capture`, `notification`) em tela do dono. Nenhum CPF/CNPJ completo.
- Migração nunca edita migração aplicada. Auditoria na mesma transação de cada mutação (`writeAuditEvent`).
- Mobile a partir de 360px, alvos de 44px.
- `order_settlements.cost` só sai por `order_settlement_cost(p_order_ref)`.

## Review Focus

- Dois repasses simultâneos para o mesmo Bureau não passam juntos do disponível (lock `payout:<bureau>` já existe; teste de concorrência).
- Prazo `0` na configuração: tudo liberado na hora. Prazo negativo ou não inteiro: recusado.
- Estorno depois da liberação: aparece negativo em "A receber"; "Disponível" fica em 0, não negativo.
- Lançamento com exatamente `now() − prazo` (fronteira): conta como liberado.
- Pedido online cancelado/devolvido: aparece na lista com status e fica fora dos totais; pedido de balcão com pagamento anulado não soma.
- Bureau sem nenhum lançamento: abas vazias com texto explicativo, sem erro.

---

### Task 1: Retenção no banco

**Files:**
- Create: `db/migrations/035_payable_retention.sql`
- Test: `src/lib/payables/retention.integration.test.ts`

**Depends-on:** none (depois do commit da 034)

**Interfaces:**
- Produces (SQL):
  - Linha em `settings`: `('payable_retention_days', '30'::jsonb, 'Dias de retenção do valor a receber antes de poder ser repassado')` com `on conflict do nothing`, e política de leitura dessa chave para a equipe do Bureau (mesmo molde de `027_affiliate_commission.sql:22`).
  - `payable_retention_days() returns integer`: lê a chave; valor ausente ou inválido volta 30.
  - `payable_buckets(p_bureau_id uuid) returns table (released numeric, retained numeric, next_release_at timestamptz)`: soma dos lançamentos `accrual` e `reversal` ainda sem `payout_items`, separados por `created_at <= now() − prazo` (released) e depois disso (retained); cada soma com `greatest(0, …)`; `next_release_at` = menor `created_at + prazo` entre os retidos. Equipe do Bureau lê só o próprio Bureau; superadmin lê qualquer um.
  - `create_payout` (nova versão, `create or replace`): recusa com `reason = 'cutoff_within_retention'` quando `p_cutoff_at > now() − prazo`. O resto da função não muda.

- [ ] Escrever primeiro os testes de integração (Postgres em 127.0.0.1:54329): repasse com cutoff dentro da retenção é recusado (`cutoff_within_retention`); cutoff exatamente em `now() − prazo` passa; prazo `0` libera tudo; `payable_buckets` separa released/retained e nunca devolve negativo; Bureau A não lê o Bureau B; dois `create_payout` simultâneos não pagam o mesmo lançamento duas vezes.
- [ ] Implementar a migração. Siga o estilo das funções de `016_payouts_nfse.sql` (`security definer`, `set search_path`, checagem `app_context_present()`).
- [ ] Rodar `npm run db:migrate` e `npx vitest run src/lib/payables` → tudo verde.

### Task 2: Pedidos online e Balcão (consultas)

**Files:**
- Create: `src/lib/wallet/sales.ts`, `src/lib/wallet/sales.test.ts`, `src/lib/wallet/sales.integration.test.ts`

**Depends-on:** none

**Interfaces:**
- Produces:
  - `type SaleRow = { orderRef: string; holderName: string; productName: string; createdAt: Date; mode: "online" | "counter"; paid: string; cost: string; bureauShare: string; status: "paid" | "awaiting" | "cancelled" | "refunded" }` (valores `numeric` como string).
  - `listSales(client: PoolClient, args: { mode: "online" | "counter"; range: { start: string; end: string }; cursor?: string | null; limit?: number }): Promise<{ rows: SaleRow[]; totals: { paid: string; cost: string; bureauShare: string }; nextCursor: string | null }>`
  - Regras: `paid` online = `order_settlements.price` quando `captured` ou `reserved`; balcão = soma de `counter_payments` não anuladas. `cost` vem de `order_settlement_cost()`. `bureauShare = paid − cost` quando quitado; senão 0. Cancelado e devolvido ficam na lista e fora de `totals`. Limite padrão 50, cursor por `(created_at, order_ref)`. Reuse `deriveStatus`/regras de `src/lib/counter-payments/overview.ts` em vez de repetir.
- Consumes: `parseRevenuePeriod`/`revenueRange` de `src/lib/dashboard/period.ts` (a UI converte o período em `range`).

- [ ] Testes unitários da derivação de status e dos totais (pedido cancelado fora do total; balcão com pagamento anulado; parcial = `awaiting`; sem custo = erro tratado).
- [ ] Teste de integração: um Bureau com um pedido online e um de balcão devolve cada um só na sua aba; outro Bureau não aparece.
- [ ] Implementar `listSales` com SQL parametrizado. Rodar `npx vitest run src/lib/wallet` → verde.

### Task 3: Extrato total (consulta)

**Files:**
- Create: `src/lib/wallet/statement-total.ts`, `src/lib/wallet/statement-total.test.ts`, `src/lib/wallet/statement-total.integration.test.ts`
- Modify: `src/lib/wallet/ledger-view.ts` (novos textos, sem quebrar os testes atuais)
- Create (só se não houver chave comum): `db/migrations/036_ledger_adjustment_link.sql`

**Depends-on:** none

**Interfaces:**
- Produces:
  - `type StatementLine = { id: string; at: Date; source: "prepaid" | "payable" | "client"; title: string; detail: string; amount: string; tone: "in" | "out" | "neutral" }`
  - `listWalletStatement(client: PoolClient, args: { bureauId: string; source: "all" | "prepaid" | "payable"; range: { start: string; end: string }; cursor?: string | null; limit?: number }): Promise<{ lines: StatementLine[]; nextCursor: string | null }>`
  - Junta `ledger_entries` (prepaid), `bureau_payable_entries` (payable) e os lançamentos de `client_ledger_entries` que vêm de ajuste do Bureau. Ordem por data decrescente, 50 por página. Um ajuste de conta é uma linha só: "Crédito dado a cliente. Saiu do saldo do Bureau e entrou no saldo do cliente (ajuste de conta)." Se não existir chave comum entre as duas tabelas, ligue pelo `reference`/`idempotency_key` do ajuste (veja `029_client_balance_adjustments.sql`); só crie a migração 036 se isso não bastar.
  - Textos em pt-BR simples, um por tipo de lançamento. Venda online: "Sua parte entrou em A receber". Venda no balcão: "Custo saiu do saldo pré-pago". Recarga, estorno, repasse recebido, ajuste.

- [ ] Testes: cada tipo de lançamento gera o título e o sinal certos; ajuste de conta vira uma linha; `source` filtra; paginação não repete nem perde linha na fronteira; Bureau B não lê o Bureau A.
- [ ] Implementar. Rodar `npx vitest run src/lib/wallet` → verde.

### Task 4: Detalhe do pedido igual para online e balcão

**Files:**
- Modify: `src/app/(dashboard)/settings/counter-payments/page.tsx`, `src/lib/counter-payments/queries.ts`
- Test: `src/lib/counter-payments/queries.integration.test.ts` (adicionar casos)

**Depends-on:** none

**Interfaces:**
- Produces: `listCounterPayments` passa a devolver também `mode: "online" | "counter"`, `paidOnline: string | null` (preço quando online com liquidação), `cost: string | null` e `bureauShare: string | null`.
- Tela: online mostra "Pago pelo app (saldo do cliente)", valor pago, custo, parte do Bureau, "Quitado", e esconde `CounterPaymentForm`. Balcão fica como está, com a parte do Bureau acrescentada. A chamada de `registerCounterPayment` em pedido online é recusada também no servidor (`src/actions/counter-payments.ts`, razão `online_order`).

- [ ] Teste: pedido online com liquidação `captured` retorna `mode: "online"` e "Quitado"; ação de registrar pagamento de balcão em pedido online devolve `{ error }`; balcão sem mudança.
- [ ] Implementar e rodar `npx vitest run src/lib/counter-payments src/actions/counter-payments.test.ts` → verde.

### Task 5: Prazo de retenção no superadmin

**Files:**
- Modify: `src/lib/settings/readers.ts`, `src/actions/settings.ts`, `src/components/layout/nav-items.ts` (item no menu do superadmin), `src/lib/validators/` (schema zod)
- Create: `src/app/(superadmin)/superadmin/settings/repasses/page.tsx`, `src/components/settings/payable-retention-form.tsx`
- Test: `src/actions/settings.test.ts` (casos novos), `src/lib/settings/readers.test.ts`

**Depends-on:** 1

**Interfaces:**
- Produces: `readPayableRetentionDays(identity: DbIdentity): Promise<number>` (padrão 30 se ausente/inválido); `savePayableRetentionAction(values: unknown): Promise<{ error: string | null }>` (superadmin; zod inteiro 0–365; grava em `settings` e escreve auditoria `settings.payable_retention` na mesma transação). Segue o molde das ações de afiliados (`settings.ts:180`) e de `AffiliateSettingsForm`.

- [ ] Testes: valor válido grava e audita; 30.5, −1, 366 e texto são recusados; papel que não é superadmin é recusado; leitor devolve 30 sem linha.
- [ ] Implementar. Rodar `npx vitest run src/actions/settings.test.ts src/lib/settings` → verde.

### Task 6: Repasse respeita a retenção

**Files:**
- Modify: `src/lib/payables/queries.ts`, `src/actions/payouts.ts`, `src/app/(superadmin)/superadmin/payouts/` (tela que cria o repasse), mapa de motivos de erro de repasse
- Test: `src/lib/payables/queries.integration.test.ts`, `src/actions/payouts.test.ts`

**Depends-on:** 1

**Interfaces:**
- Produces: `getPayableBuckets(client: PoolClient, bureauId: string): Promise<{ released: string; retained: string; nextReleaseAt: Date | null; paid: string }>` (chama `payable_buckets`; `paid` = soma dos lançamentos `payout`, em valor positivo).
- `createPayoutAction`: o cutoff padrão passa a ser `now() − prazo` (usa `readPayableRetentionDays`); o motivo `cutoff_within_retention` vira a mensagem "Esse valor ainda está em liberação. Escolha uma data até {data}."

- [ ] Testes: ação com cutoff dentro da retenção devolve a mensagem; cutoff padrão paga só lançamentos liberados; `getPayableBuckets` bate com o que `create_payout` aceitaria (mesmo número).
- [ ] Implementar e rodar `npx vitest run src/lib/payables src/actions/payouts.test.ts` → verde.

### Task 7: Telas da Carteira

**Files:**
- Modify: `src/app/(dashboard)/settings/wallet/page.tsx`, `src/lib/wallet/tabs.ts`, `src/lib/wallet/tabs.test.ts`, `src/components/wallet/WalletTabs.tsx`, `src/components/payouts/PayablesPanel.tsx`, `src/components/counter-payments/CounterPaymentsOverview.tsx`
- Create: `src/components/wallet/SalesTab.tsx`, `src/components/wallet/StatementTab.tsx`, `src/components/wallet/PayoutsTab.tsx`, `src/components/wallet/TabIntro.tsx`

**Depends-on:** 2, 3, 6

**Interfaces:**
- Consumes: `listSales`, `listWalletStatement`, `getPayableBuckets`, `readPayableRetentionDays`.
- Produces: abas por `?aba=`: `online`, `balcao`, `extrato`, `receber` (padrão `online`); aba que o usuário não pode ver cai na padrão. Valores antigos (`a-receber`) redirecionam para `receber`. Cada aba abre com `TabIntro` (uma frase). Pedidos online e Balcão usam os chips de período do Dashboard e mostram o total do período. Extrato total tem chips Tudo / Saldo pré-pago / A receber e paginação. A receber e saques mostra Disponível para saque, Em liberação (com a data de `nextReleaseAt`) e Já repassado, a lista de lançamentos e o histórico de repasses. Cartões do topo: "Saldo pré-pago" e "A receber" com frase de explicação.

- [ ] Teste de `tabs.ts`: lista permitida, valor desconhecido → `online`, `a-receber` → `receber`, aba sem permissão → `online`.
- [ ] Implementar as abas. Rodar `npx tsc --noEmit`, `npm run lint`, `npx vitest run src/lib/wallet src/components` → verde.
- [ ] Conferir no navegador (Playwright MCP) a Carteira em 360px e 1280px com os dados do seed.

---

## Ondas

- **Onda 1 (paralelo):** Tasks 1, 2, 3, 4 (arquivos disjuntos).
- **Onda 2 (paralelo):** Tasks 5, 6 (dependem da 1).
- **Onda 3:** Task 7 (depende de 2, 3, 6).

Documentação (`docs/operations/` e `PRODUCT.md`: retenção de 30 dias, abas da Carteira) não entra no plano; vai direto a um agente Haiku ao fim.

## Pós-deploy (post-deploy)

- No primeiro deploy, lançamentos com mais de 30 dias ficam liberados. Conferir o "Disponível para saque" de cada Bureau com o superadmin.
- Conferir o pedido real do Thomas: os R$ 6 em "Em liberação" e a tela do pedido como "Pago pelo app".

## Self-review

- Cobertura da spec: abas (T7), cartões do topo (T7), Pedidos online/Balcão (T2, T7), Extrato total (T3, T7), detalhe do pedido (T4), retenção e bloqueio (T1, T6), configuração do superadmin (T5), decisões da revisão (T1, T2, T3).
- Tipos: `SaleRow`, `StatementLine`, `getPayableBuckets` e `readPayableRetentionDays` têm o mesmo nome onde são consumidos.
- Proporção: 7 tarefas, sem tarefa de revisão. A revisão acontece uma vez, ao fim, com `/code-review`.
