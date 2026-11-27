# Split na entrada de dinheiro (sócios, bureau, bureau indicador, afiliado) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dividir por split Asaas todo dinheiro que entra na plataforma por cobrança Asaas, entre sócios, bureau dono do cliente, bureau indicador e afiliado de link. A plataforma fica com o que sobra na conta raiz.

**Architecture:** Toda cobrança criada pelo sistema leva `split` na criação, calculado por `buildSplitPlan` sobre o valor líquido. Cada beneficiário tem `walletId`. O afiliado de link e o bureau indicador também podem usar o modo Pix (crédito no livro-razão na confirmação, carência padrão 0). A comissão calculada na captura do pedido (`capture_order`) é removida.

**Tech Stack:** Next.js 14 App Router, TypeScript, `pg` (SQL cru, `withUserTransaction`), zod, shadcn/ui, Asaas API v3.

**Spec:** `docs/superpowers/specs/2026-11-26-afiliado-bureaus-design.md`. Parte 2 (telas do afiliado): `docs/superpowers/plans/2026-11-26-afiliado-bureaus-2-telas-afiliado.md`.

## Decisões fechadas pelo usuário (2026-11-26)

- Base de cálculo: valor líquido da cobrança (`netValue`, depois das taxas do Asaas).
- Comissão da captura do pedido sai, para não pagar duas vezes.
- Sócios, parte do bureau, bureau indicador e afiliado de link usam a mesma lógica de split na entrada.
- Percentual do afiliado de link e do bureau: os valores atuais, aplicados sobre a entrada líquida.
- Sócios: cadastro em `superadmin/settings` com nome, `walletId` e percentual.
- A plataforma fica com a sobra na conta raiz.
- Estorno em modo Pix: saldo do afiliado pode ficar negativo e é abatido das próximas comissões.
- Saldos antigos de comissão do bureau já foram repassados fora do sistema: zerar com lançamento de ajuste auditado.
- Cupom: só baixa o valor pago. A regra de desconto sobre a comissão do bureau e o estorno de cupom ligado a ela saem.
- Saldo creditado à mão e consumo de saldo nunca geram comissão.

## Calls do assistente (confirmar)

- **C1.** Cobrança paga por bureau para recarregar a própria carteira (`wallets`, migração 012): só os sócios recebem. Bureau, indicador e afiliado não.
- **C2.** Bureau sem `walletId`: a parte dele vira lançamento `accrual` em `bureau_payable_entries` na confirmação do pagamento (fluxo de repasse manual atual), em vez de bloquear a cobrança. Bureau sem percentual configurado: 0%.
- **C3.** Sócio ou bureau com `walletId` recusado pelo Asaas: o split recusado fica `refused`, vira alerta no painel, e a parte volta para a plataforma.
- **C4.** Todo cliente pertence a um bureau.

## Global Constraints

- Migrações: `065_afiliado_split_schema.sql` e `066_split_sem_comissao_captura.sql`. A `062` já existe em `main`. A `063` e a `064` estão reservadas pelo plano `2026-11-26-fluxo-cliente-2-pagamento-por-pedido.md`. Rode `ls db/migrations` antes e use o próximo número livre, também neste plano. Nunca editar migração aplicada. Sem Supabase.
- As Tasks 2 e 3 rodam depois que a parte 2 do fluxo do cliente for mesclada (ela muda `pix-charges.ts`, `checkout.ts`, `route.ts` do webhook e `apply_asaas_payment`).
- Soma de todas as camadas <= 100% do valor líquido. A cobrança não é criada se passar (`SplitOver100Error`). Reusar `lockCommissionSplit` e `assertSplitWithin100` (`src/lib/commission/queries.ts`).
- Dinheiro em centavos inteiros. A sobra de arredondamento fica com a plataforma.
- Cada query roda em `withUserTransaction({ userId, role }, fn)`. Evento de auditoria na mesma transação de cada mutação. Nenhuma chamada HTTP (Asaas) dentro de transação.
- `walletId` e chave Pix só mascarados em logs, auditoria e erros.
- Server Action: zod `safeParse`, sessão, `hasPermission(role, "<resource>:<verb>")`, query, `revalidatePath`. Retorno `{ error: string | null, id? }`.
- Textos de UI, erros e comentários em pt-BR. Identificadores em inglês. Imports com `@/`.
- Testes ao lado do código. `*.integration.test.ts` usa Postgres real (`127.0.0.1:54329`).

## Review Focus

- Soma das camadas acima de 100%: bloquear a criação da cobrança.
- Webhook repetido (`PAYMENT_RECEIVED` duas vezes): nada duplica, em modo Pix e no `accrual` do bureau sem `walletId`.
- Crédito manual de saldo e consumo de saldo: zero comissão, zero split.
- Cobrança de recarga do próprio bureau: só sócios (C1).
- Pedido já em andamento na virada: o pedido reservado antes da migração 066 não perde nem duplica a comissão do bureau.
- Split recusado, estorno e chargeback: divergência na auditoria e visível no painel, sem saldo negativo silencioso.
- Beneficiário muda de modo ou de `walletId` com cobrança em andamento: a cobrança já criada mantém o plano do momento da criação.
- Cobrança de bureau sem nenhum percentual configurado: cria sem split de bureau.

---

### Task 1: Schema e tipos

**Files:**
- Create: `db/migrations/065_afiliado_split_schema.sql`
- Modify: `src/lib/affiliates/types.ts`
- Test: `src/lib/affiliates/split-schema.integration.test.ts`

**Depends-on:** nenhuma. **Agente:** `database-architect` (sonnet).

**Interfaces:**
- Produces:
  - `platform_partners(id, name, asaas_wallet_id, pct numeric check (pct > 0 and pct <= 100), active bool, created_at)`. RLS: só `superadmin`.
  - `bureau_referrals(id, referrer_bureau_id, referred_bureau_id unique, pct numeric default 5, active bool, created_at)`. Check `referrer <> referred`; proteção contra ciclo.
  - `payout_method text check in ('asaas','pix') default 'pix'` e `asaas_wallet_id text null` em `affiliate_wallets`. Em `bureaus` (ou tabela de configuração do bureau): `asaas_wallet_id text null`.
  - `bureau_affiliate_settings.affiliate_enabled bool default false`.
  - `charge_splits(id, pix_charge_id, beneficiary_kind 'partner'|'bureau'|'bureau_referrer'|'affiliate', beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents, asaas_split_id null, status 'pending'|'done'|'refused'|'refunded'|'reversal_failed', created_at)`, `unique (pix_charge_id, beneficiary_kind, beneficiary_id)`. RLS por bureau dono da cobrança; sócios visíveis só ao `superadmin`.
  - Origem `cash_in` no livro-razão de afiliado. Padrão de `affiliate_commission_hold_days` passa a 0 para instalações novas (não altera valor já gravado).
- Types: `PayoutMethod`, `ChargeSplitStatus`, `BeneficiaryKind` em `types.ts`.

- [ ] **Step 1:** Teste de integração: auto-indicação falha; segundo indicador para o mesmo B falha; ciclo A->B e B->A falha; `payout_method` inválido falha; `pct` de sócio fora de (0,100] falha; duplicar `charge_splits` falha; `bureau_admin` não lê `platform_partners`.
- [ ] **Step 2:** Rodar `npm run test -- split-schema.integration` e ver falhar.
- [ ] **Step 3:** Escrever a migração e os tipos.
- [ ] **Step 4:** `npm run db:migrate` e rodar o teste até passar. `npm run type-check`.
- [ ] **Step 5:** Commit `feat(db): schema de split na entrada, sócios e indicação entre bureaus`.

### Task 2: Cliente Asaas com split e eventos de webhook

**Files:**
- Modify: `src/lib/asaas/client.ts`, `src/lib/asaas/types.ts`, `src/lib/asaas/fake.ts`, `src/app/api/webhooks/asaas/route.ts`
- Test: `src/lib/asaas/asaas.test.ts`, teste do webhook ao lado da rota

**Depends-on:** fluxo do cliente parte 2 mesclada. **Agente:** `backend-specialist` (sonnet).

**Interfaces:**
- Produces: `AsaasSplitItem = { walletId: string; percentualValue?: number; fixedValue?: number }`. Todos os métodos que criam cobrança (Pix, cartão, boleto, link) aceitam `split?: AsaasSplitItem[]` e o enviam no corpo. O fake registra o split recebido. Constantes `ASAAS_EVENT_PAYMENT_SPLIT_DONE`, `ASAAS_EVENT_PAYMENT_SPLIT_REFUSED`. O construtor confirma na documentação os nomes dos eventos de chargeback e cria as constantes.
- Webhook: `route.ts` trata os eventos de split e de chargeback antes de `apply_asaas_payment`, grava auditoria e atualiza `charge_splits` (idempotente por `splitId`). Não criar valor novo em `asaas_webhook_events_result_check` (a migração 064 do fluxo do cliente a reescreve).

- [ ] **Step 1:** Testes: o corpo da cobrança leva `split` quando informado e não leva quando vazio, em cada tipo de cobrança; `PAYMENT_SPLIT_DONE` é idempotente e muda a linha para `done`; `PAYMENT_SPLIT_REFUSED` grava auditoria com `walletId` mascarado e muda para `refused`.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar. Sem split, o comportamento atual não muda.
- [ ] **Step 4:** Testes e `npm run type-check` passam.
- [ ] **Step 5:** Commit `feat(asaas): split de pagamento, eventos de split e chargeback`.

### Task 3: Motor de split e comissão sobre entrada

**Files:**
- Create: `src/lib/commission/split-plan.ts`, `src/lib/affiliates/cash-in.ts`
- Modify: os pontos que criam cobrança Asaas (`src/lib/payments/checkout.ts`, `src/lib/wallet/pix-charges.ts`, `src/lib/payment-links/queries.ts`) e a baixa do pagamento (`apply_asaas_payment` ou o código do webhook que a chama)
- Test: `src/lib/commission/split-plan.test.ts`, `src/lib/affiliates/cash-in.integration.test.ts`

**Depends-on:** Task 1, Task 2. **Agente:** `backend-specialist` (sonnet). Revisão final de dinheiro pelo coordenador com `opus` (uma vez, no fim do plano).

**Interfaces:**
- Produces: `buildSplitPlan(input: { netCents: number; bureauId: string; clientId: string; payerKind: "client" | "bureau" }): Promise<{ asaasSplit: AsaasSplitItem[]; pixLines: PixCashInLine[]; accrualLines: BureauAccrualLine[] }>`.
  - Camadas: sócios ativos (`platform_partners`), bureau (percentual de `resolve_bureau_commission_pct`), bureau indicador (`bureau_referrals.active`), afiliado de link (`affiliate_rates` ou `default_pct`, só com `affiliate_enabled`). `payerKind = "bureau"`: só sócios (C1).
  - Beneficiário com `walletId` e modo `asaas`: item de split. Beneficiário `pix` (só afiliado e indicador): linha para a confirmação. Bureau sem `walletId`: linha de `accrual` (C2).
  - Valida a soma <= 100% e lança `SplitOver100Error`. Grava `charge_splits` (`pending`) junto com a cobrança.
- `recordCashInCommission(ctx, { pixChargeId }): Promise<void>`: na confirmação do pagamento, cria as entradas `cash_in` do modo Pix (com a carência configurada) e os `accrual` de bureau sem `walletId`. Idempotente por `charge_splits(pix_charge_id, kind, id)`.
- A criação de cobrança chama `buildSplitPlan` e passa `asaasSplit` ao cliente Asaas. Só cobrança criada pelo sistema passa por aqui. Listar no PR cada ponto de criação encontrado.

- [ ] **Step 1:** Testes unitários: só sócios; sócios + bureau; indicador em `asaas` e em `pix`; afiliado com `affiliate_enabled` falso é ignorado; `payerKind = "bureau"` só sócios; bureau sem `walletId` gera `accrual`; bureau sem percentual gera zero; soma > 100% lança erro; soma das linhas igual ao líquido em centavos. Integração: recarga paga gera as linhas esperadas; webhook repetido não duplica; crédito manual e pedido pago com saldo geram zero; mudar `walletId` depois da criação não altera a cobrança.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar e ligar em todos os pontos de criação de cobrança e na baixa do pagamento.
- [ ] **Step 4:** Testes passam. `npm run check`.
- [ ] **Step 5:** Commit `feat(comissao): split na entrada de dinheiro por cobrança Asaas`.

### Task 4: Remover a comissão da captura do pedido

**Files:**
- Create: `db/migrations/066_split_sem_comissao_captura.sql`
- Modify: as funções SQL `reserve_order`, `capture_order`, `open_order` (versão mais recente: migração 055) e `create_payout`/`mark_payout_paid` só se a remoção exigir; `src/lib/settlement/queries.ts`, `src/lib/payables/queries.ts`, `src/lib/commission/queries.ts`, `src/lib/bureau-admin/metrics.ts`, `src/lib/dashboard/queries.ts`, `src/lib/wallet/{sales,statement-total}.ts`, `src/lib/orders/{staff,client}-queries.ts`, `src/lib/settings/readers.ts`, `src/test/seed.ts`
- Test: atualizar `src/lib/settlement/{commission-split,commission-rls,coupon-commission,money-fixes,settlement,queries}.integration.test.ts`, `src/lib/commission/queries.integration.test.ts`, `src/lib/affiliates/{commission,rates}.integration.test.ts`, `src/lib/payments/coupon-clawback*.test.ts`, `src/actions/settings.test.ts`

**Depends-on:** Task 3. **Agente:** `database-architect` para o SQL; `backend-specialist` para o TypeScript e os testes (sonnet).

**Interfaces:**
- Produces: `reserve_order` deixa de gravar `commission_pct` e `bureau_commission`; `capture_order` deixa de criar `accrual` do bureau e `affiliate_commissions`. Pedidos já reservados antes da virada mantêm o tratamento antigo (a função distingue por `commission_pct is not null`) para não perder nem duplicar comissão. Relatórios de comissão passam a ler `charge_splits`, `affiliate_ledger_entries` (origem `cash_in`) e `bureau_payable_entries` (só `accrual` de bureau sem `walletId`).
- A regra "desconto reduz a comissão do bureau" e o estorno de cupom ligado a ela saem. Cupom só baixa o valor pago.

- [ ] **Step 1:** Atualizar os testes para o novo comportamento e escrever o teste de transição: pedido reservado antes da virada captura com a regra antiga e não gera comissão dupla.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Escrever a migração 066 e ajustar o TypeScript e os leitores.
- [ ] **Step 4:** Todos os testes de dinheiro passam. `npm run check`.
- [ ] **Step 5:** Commit `refactor(comissao): comissão deixa de nascer na captura do pedido`.

### Task 5: Cadastro de sócios e `walletId` do bureau

**Files:**
- Create: `src/lib/partners/queries.ts`, `src/app/(superadmin)/superadmin/settings/socios/page.tsx`, `src/app/(superadmin)/superadmin/settings/socios/actions.ts`
- Modify: `src/app/(superadmin)/superadmin/settings/page.tsx` (card "Sócios"), `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx` (campo `walletId` do bureau), `src/lib/validators/` (schemas novos)
- Test: `src/lib/partners/queries.integration.test.ts`

**Depends-on:** Task 1. **Agente:** `backend-specialist` e `frontend-specialist` (sonnet).

**Interfaces:**
- Produces: `listPartners(ctx)`, `upsertPartner(ctx, { id?, name, asaasWalletId, pct, active }): Promise<{ error: string | null }>`, `setBureauWalletId(ctx, { bureauId, asaasWalletId })`. Permissões `partner:manage` e `bureau_wallet:manage`, só `superadmin`. A soma dos percentuais de sócios ativos e das demais camadas máximas não passa de 100% (reusar `lockCommissionSplit`). Auditoria em cada mudança, `walletId` mascarado.

- [ ] **Step 1:** Testes: só `superadmin` chama; `pct` inválido recusado; soma > 100% recusada; `walletId` mascarado na auditoria; RLS esconde sócios do bureau.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar queries, Server Actions e telas.
- [ ] **Step 4:** Testes passam.
- [ ] **Step 5:** Commit `feat(superadmin): cadastro de sócios e walletId do bureau`.

### Task 6: Estorno, chargeback e zerar saldos antigos

**Files:**
- Create: `src/lib/affiliates/reversal.ts`, `scripts/db/zero-legacy-bureau-payables.mjs`
- Modify: o ramo de estorno em `route.ts` do webhook e em `apply_asaas_payment`
- Test: `src/lib/affiliates/reversal.integration.test.ts`, teste do script com `node --test`

**Depends-on:** Task 3. **Agente:** `backend-specialist` (sonnet).

**Interfaces:**
- Produces: `reverseCashInCommission(ctx, { pixChargeId }): Promise<void>`: no estorno da cobrança, cria a reversão das linhas do modo Pix (saldo do afiliado pode ficar negativo e é abatido das próximas comissões) e reverte o `accrual` do bureau sem `walletId`. Em modo `asaas`, o Asaas reverte o split; a linha vira `refunded`, ou `reversal_failed` se a reversão não ocorrer. Chargeback atualiza o status e a auditoria.
- Script `zero-legacy-bureau-payables.mjs`: com `--dry-run` (padrão) lista, por bureau, o total em aberto em `bureau_payable_entries`; com `--apply` grava um lançamento de ajuste auditado por bureau que zera o saldo, sem apagar linhas. Usa `DATABASE_OWNER_URL`. Não roda sozinho: o usuário executa em produção depois de conferir a lista.

- [ ] **Step 1:** Testes: estorno em modo Pix gera reversão e saldo negativo abatido na próxima comissão; estorno em modo `asaas` atualiza o status; script em `--dry-run` não altera nada; `--apply` zera o saldo com um lançamento por bureau e é idempotente (segunda execução não grava nada).
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Testes passam.
- [ ] **Step 5:** Commit `feat(comissao): reversão por estorno e script para zerar saldos antigos`.

### Task 7: Painel de repasses e prejuízo por cliente

**Files:**
- Create: `src/lib/affiliates/split-report.ts`, `src/components/affiliates/SplitReportTable.tsx`, `src/components/affiliates/ClientLossTable.tsx`
- Modify: `src/app/(dashboard)/afiliados/page.tsx`, `src/app/(superadmin)/superadmin/` (visão do superadmin)
- Test: `src/lib/affiliates/split-report.integration.test.ts`

**Depends-on:** Task 3, Task 6. **Agente:** `backend-specialist` e `frontend-specialist` (sonnet).

**Interfaces:**
- Produces: `listBureauSplits(ctx, { from, to, status? }): Promise<SplitReportRow[]>` (cobrança, beneficiário mascarado, valor, status). `listClientLosses(ctx, { from, to }): Promise<ClientLossRow[]>` com, por cliente: total pago por Asaas, quantidade e valor de estornos, quantidade e valor de chargebacks, percentual sobre o total pago, e comissão já paga sobre cobranças estornadas (`reversal_failed` e saldo negativo em modo Pix). O superadmin vê todos os bureaus e o total dos sócios.
- UI: duas tabelas ordenáveis por percentual de estorno. Linha `reversal_failed` e `refused` destacada.

- [ ] **Step 1:** Testes: totais e percentuais corretos com cobranças pagas, estornadas e com chargeback; `bureau_admin` só vê o próprio bureau (RLS); beneficiário mascarado; cliente sem estorno aparece com zero.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar queries e tabelas.
- [ ] **Step 4:** Testes passam.
- [ ] **Step 5:** Commit `feat(afiliados): painel de repasses e prejuízo por cliente`.

### Task 8: Documentação

**Files:**
- Modify: `docs/operations/affiliates.md`, `docs/architecture.md`, `PRODUCT.md`, `db/migrations/CLAUDE.md`

**Depends-on:** Tasks 1 a 7. **Agente:** `documentation-writer` (haiku). Texto em Simplified Technical English.

- [ ] **Step 1:** Documentar: o split na entrada e suas camadas, os dois modos, a remoção da comissão da captura, estorno e chargeback, o runbook de split recusado e o uso do script de saldos antigos. Incluir o passo "habilitar o split em Integrações > Segurança".
- [ ] **Step 2:** Commit `docs: split na entrada de dinheiro`.

## Ordem de execução

Onda 1 (paralela): Task 1. Onda 2 (paralela): Task 2, Task 5. Onda 3: Task 3. Onda 4 (paralela): Task 4, Task 6. Onda 5: Task 7. Depois: Task 8. A Parte 2 roda em paralelo a partir da Task 1. O coordenador faz os commits.

## Post-deploy follow-up

- Habilitar o split em Integrações > Segurança na conta Asaas de produção.
- Cadastrar os sócios e o `walletId` de cada bureau.
- Testar um split real em sandbox com um `walletId` de conta comum e conferir `PAYMENT_SPLIT_DONE`.
- Rodar `scripts/db/zero-legacy-bureau-payables.mjs --dry-run`, conferir a lista e só então `--apply`.
- Observar o primeiro estorno e o primeiro chargeback com split (a documentação do Asaas não cobre chargeback nem saldo insuficiente do recebedor).
