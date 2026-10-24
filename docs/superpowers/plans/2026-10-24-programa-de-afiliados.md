# Programa de afiliados — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project override: waves and review rules in `.claude/rules/08-parallel-subagent-driven-development.md` and "Lean delivery" in `CLAUDE.md` (no per-task reviewer; implementers do not commit; the coordinator commits one conventional commit per task; one final review).

**Goal:** Link de afiliado por cliente, comissão de % da margem do Bureau em compra online capturada, carência com reversão em estorno de recarga, saldo de comissão sacável ou conversível em créditos, saque manual com taxa, e as telas de afiliado, Bureau e superadmin.

**Architecture:** Regras de dinheiro em PL/pgSQL (migrations `026`–`028`), no padrão do livro-razão: `affiliate_wallets` + `affiliate_ledger_entries` imutáveis, uma porta única de lançamento (`affiliate_wallet_post_entry`), a comissão gravada em `capture_order` na mesma transação do accrual, a reversão em `apply_asaas_payment`, a liberação por varredura no tick. TypeScript só valida, chama as funções e mostra.

**Tech Stack:** Next.js 14 App Router, Server Actions, zod, `pg` sem ORM, PostgreSQL 18 com RLS, Vitest (unit e integração em `127.0.0.1:54329`), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-programa-de-afiliados-design.md`

## Global Constraints

- Migrations novas: `026_affiliates_core.sql`, `027_affiliate_commission.sql`, `028_affiliate_withdrawals.sql`. Funções existentes são redefinidas com `create or replace` nessas migrations (não edite 001–025). Uma assinatura nova (ex.: `register_client`) faz `drop function` da antiga e refaz `owner`, `revoke` e `grant` como em `021:669-694`.
- Dinheiro `numeric(15,2)`; % `numeric(5,2)` de 0 a 100. Arredondamento `round(x, 2)`.
- Comissão = `round(pct × (preço − custo) / 100, 2)` com `preço`/`custo` de `order_settlements`; só `mode = 'online'`; accrual do Bureau = margem − comissão, gravado só se `> 0`.
- `settings`: `affiliate_commission_hold_days` (inteiro, padrão 30) e `affiliate_withdrawal_fee` (`{"fixed": 0, "percent": 0}`), seed na `026`.
- Toda tabela nova com RLS `enable` + `force` e caso em `src/lib/db/rls.integration.test.ts`. Toda função `security definer` com `set search_path = pg_catalog, public`, dono e grants no padrão das funções da 019/025.
- Auditoria na mesma transação; nunca CPF/CNPJ completo nem chave PIX em log ou auditoria. Textos de interface em pt-BR.
- Padrões do `AGENTS.md`: zod `safeParse` → sessão → `hasPermission` → query → `revalidatePath`; `{ ok: false, reason }`.
- Testes de integração: cada tarefa usa o próprio banco `credit_system_aN_test` (o coordenador cria) via `TEST_DATABASE_*`; `npx vitest run`, nunca `npm run test` durante as ondas.
- Implementers: especialista com `model: sonnet`. Gate: testes da tarefa verdes (2 tentativas, depois escalar).

## Review Focus

1. **Afiliado anonimizado** cujo indicado continua comprando: nenhuma comissão nova. Teste na Tarefa 2.
2. **Código de indicação inválido, de outro Bureau, do próprio cliente ou de conta anonimizada** no cadastro: cadastro conclui sem vínculo e sem erro para quem se cadastra. Teste na Tarefa 1.
3. **Saque e conversão em paralelo** sobre o mesmo saldo disponível: nunca negativo, um dos dois recusa com `insufficient_funds`. Teste na Tarefa 3.
4. **Estorno de recarga depois que a comissão foi liberada**: nenhuma reversão, `refund_shortfall` igual ao de antes. Teste na Tarefa 2.
5. **% alterada depois da captura**: a comissão gravada não muda; o próximo pedido usa a % nova. Teste na Tarefa 2.

---

### Task 1: Núcleo — código, vínculo, carteira de comissão e cadastro com indicação

**Agent:** `database-architect` · **Depends-on:** none
**Files:**
- Create: `db/migrations/026_affiliates_core.sql`, `src/lib/affiliates/types.ts`, `src/lib/affiliates/queries.ts`, `src/lib/affiliates/core.integration.test.ts`
- Modify: `src/lib/db/permissions.ts`, `src/lib/db/rls.integration.test.ts`, `src/lib/wallet/client-queries.ts` (tipo `kind` + `commission_credit`), `src/components/wallet/LedgerTable.tsx` (`KIND_LABEL`: "Comissão convertida"), `src/lib/account/queries.ts` (`registerClient` passa `referralCode`)

**Interfaces:**
- Schema (026):
  - `affiliate_codes (profile_id uuid primary key references profiles(id), bureau_id uuid not null, code text not null unique check (code ~ '^[a-z0-9]{8}$'), created_at)`. Código aleatório de 8 caracteres `[a-z0-9]`, gerado no banco.
  - `affiliate_referrals (referred_profile_id uuid primary key references profiles(id), affiliate_profile_id uuid not null references profiles(id), bureau_id uuid not null, created_at)`, `check (referred_profile_id <> affiliate_profile_id)`, imutável.
  - `bureau_affiliate_settings (bureau_id uuid primary key, default_pct numeric(5,2) not null default 0 check (default_pct between 0 and 100), updated_by, updated_at)`.
  - `affiliate_rates (bureau_id uuid not null, affiliate_profile_id uuid not null, pct numeric(5,2) not null check (pct between 0 and 100), updated_by, updated_at, primary key (bureau_id, affiliate_profile_id))`.
  - `affiliate_wallets (profile_id uuid primary key, bureau_id uuid not null, pending numeric(15,2) not null default 0 check (pending >= 0), available numeric(15,2) not null default 0 check (available >= 0))`.
  - `affiliate_ledger_entries (id, profile_id, bureau_id, kind text check (kind in ('commission','commission_release','commission_reversal','conversion','withdrawal_hold','withdrawal_paid','withdrawal_release')), amount numeric(15,2) check (amount > 0), pending_after, available_after, idempotency_key text not null, reference text, created_by, created_at, unique (profile_id, idempotency_key))`, imutável (mesmo trigger do livro-razão).
  - `affiliate_commissions (id uuid pk, order_ref uuid not null unique, bureau_id, affiliate_profile_id, referred_profile_id, pct numeric(5,2), margin numeric(15,2), amount numeric(15,2) check (amount > 0), reversed_amount numeric(15,2) not null default 0 check (reversed_amount between 0 and amount), status text check (status in ('pending','released','reversed')), release_at timestamptz not null, created_at)`. Só funções `security definer` escrevem.
  - Trigger em `profiles` (role `client`): cria `affiliate_codes` e `affiliate_wallets` (padrão de `profiles_create_client_wallet`, 015:~247). Backfill para clientes que já existem.
  - Seeds de `settings` (Global Constraints).
- Funções (026):
  - `affiliate_wallet_post_entry(p_profile_id uuid, p_kind text, p_amount numeric, p_idempotency_key text, p_reference text, p_created_by uuid) returns table (ok boolean, reason text, entry_id uuid, pending numeric, available numeric, replayed boolean)`: `for update` na carteira; idempotente por chave; efeitos: `commission` +pending; `commission_release` pending→available; `commission_reversal` −pending; `conversion`, `withdrawal_hold` −available; `withdrawal_release` +available; `withdrawal_paid` sem efeito no saldo (só registro). Falta de saldo → `insufficient_funds`.
  - `client_wallet_post_entry` (redefinida, base 018:148) e o CHECK de `client_ledger_entries.kind` (015:40, constraint inline: dropar pelo nome gerado e recriar): kind novo `commission_credit` → `available += amount`.
  - `register_client(..., p_referral_code text default null)`: depois de criar o perfil, grava `affiliate_referrals` só se o código existe, é do mesmo Bureau, o dono não está anonimizado e não é autoindicação (mesmo e-mail, mesmo documento do titular ou mesmo telefone do dono do código). Em qualquer outro caso ignora sem erro.
- TS:
  - `src/lib/db/permissions.ts`: + `"affiliates:read"`, `"affiliates:manage"`, `"withdrawals:manage"`. `client` + `affiliates:read`; `bureau_admin` + `affiliates:manage`; `superadmin` + `withdrawals:manage`.
  - `src/lib/affiliates/types.ts`: `AffiliateWallet = { pending: string; available: string }`; `CommissionStatus = "pending" | "released" | "reversed"`; `AffiliateCommissionRow = { createdAt: string; referredName: string; productName: string; orderValue: string; amount: string; status: CommissionStatus; releaseAt: string }`; `AffiliateReferralRow = { name: string; createdAt: string; totalSpent: string }`.
  - `src/lib/affiliates/queries.ts`: `getMyAffiliateSummary(client: PoolClient): Promise<{ code: string; wallet: AffiliateWallet; referrals: AffiliateReferralRow[]; commissions: AffiliateCommissionRow[] } | null>` (só os próprios dados, via RLS ou função `security definer` com posse; nunca documento nem resultado de consulta).
  - `registerClient(input: RegisterClientInput & { referralCode?: string | null })`.

- [ ] **Step 1: Testes que falham** (`core.integration.test.ts`, `rls.integration.test.ts`):
  - cliente novo ganha código de 8 caracteres e carteira de comissão zerada; cliente antigo recebe pelo backfill.
  - `register_client` com código válido do mesmo Bureau → vínculo; código de outro Bureau, inexistente, de conta anonimizada, autoindicação por e-mail e por documento → `ok` sem vínculo.
  - `affiliate_wallet_post_entry`: `commission` 40,00 → pending 40,00; `commission_release` 40,00 → available 40,00; `conversion` 50,00 → `insufficient_funds`; mesma chave duas vezes → `replayed`.
  - `client_wallet_post_entry('commission_credit', 40.00)` → available +40,00.
  - RLS: cliente lê só o próprio código, carteira, vínculos onde é afiliado e comissões próprias; Bureau não lê dados de outro Bureau.
- [ ] **Step 2:** `npx vitest run src/lib/affiliates src/lib/db/rls.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implemente a 026 e o TS. `db:reset` no próprio banco.
- [ ] **Step 4:** mesmo comando → PASS; `npx vitest run src/lib src/actions` → PASS; `npm run type-check` → sem erro.
- [ ] **Step 5 (coordenador):** `feat(affiliates): código de afiliado, vínculo no cadastro e carteira de comissão`

### Task 2: Comissão na captura, carência, reversão no estorno e bloqueio LGPD

**Agent:** `database-architect` · **Depends-on:** Task 1
**Files:**
- Create: `db/migrations/027_affiliate_commission.sql`, `src/lib/affiliates/commission.integration.test.ts`
- Modify: `src/lib/orders/tick.ts` (passo novo + contador `commissionsReleased` em `TickResult`), `src/lib/lgpd/queries.ts`, `src/lib/lgpd/types.ts`, `src/actions/lgpd.ts` (motivo `commission`)

**Interfaces:**
- `capture_order(p_order_ref uuid)` (redefinida, base 019:132; mesma assinatura e retorno). Depois do `client_wallet_post_entry(... 'capture' ...)` no ramo online, troque o accrual por:

```sql
v_margin := v_s.price - v_s.cost;
v_commission := 0;
select r.affiliate_profile_id into v_affiliate
  from public.affiliate_referrals r join public.profiles p on p.id = r.affiliate_profile_id
 where r.referred_profile_id = v_s.client_profile_id and p.anonymized_at is null;
if v_affiliate is not null and v_margin > 0 then
  v_pct := coalesce(
    (select pct from public.affiliate_rates where bureau_id = v_s.bureau_id and affiliate_profile_id = v_affiliate),
    (select default_pct from public.bureau_affiliate_settings where bureau_id = v_s.bureau_id), 0);
  v_commission := round(v_pct * v_margin / 100, 2);
end if;
if v_margin - v_commission > 0 then
  insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
  values (v_s.bureau_id, 'accrual', v_margin - v_commission, v_s.order_ref);
end if;
if v_commission > 0 then
  -- affiliate_commissions (status 'pending', release_at = now() + hold_days) e
  -- affiliate_wallet_post_entry(v_affiliate, 'commission', v_commission, 'order:commission:' || p_order_ref, 'order:' || p_order_ref, v_user)
end if;
```
  `hold_days` lido de `settings` (`affiliate_commission_hold_days`, padrão 30 se ausente). Auditoria `affiliate.commission` (sem documento).
- `apply_asaas_payment` (redefinida, base 019:306; mesma assinatura). No ramo `PAYMENT_REFUNDED`, depois do clawback (019:426) e antes do `update ... refund_shortfall` (019:423 — reordene para gravar o valor final): com `v_left := v_shortfall - v_clawback`, percorra `affiliate_commissions` do indicado `v_charge.client_profile_id` com `status = 'pending'`, da mais nova para a mais antiga, `for update`; para cada uma reverta `least(amount − reversed_amount, v_left)` com `affiliate_wallet_post_entry(..., 'commission_reversal', ..., 'refund:' || v_charge.id || ':' || c.id, ...)`, some em `reversed_amount`, `status = 'reversed'` quando zerar, e desconte de `v_left`. `refund_shortfall = v_left`. Comissão `released` não é tocada.
- `release_due_commissions(p_limit integer default 500) returns integer` (`security definer`, só identidade de plataforma): para `affiliate_commissions` `pending` com `release_at <= now()`, `commission_release` de `amount − reversed_amount` (se > 0) e `status = 'released'`; devolve quantas liberou.
- `lgpd_anonymize_client_account` (redefinida, base 023:209): devolve `'commission'` se a carteira de comissão tem `pending + available > 0` ou se existe saque `open` (a tabela de saques nasce na 028: use `to_regclass('public.affiliate_withdrawals')` para não depender da ordem, ou deixe a checagem de saque para a Tarefa 3 e registre no relatório).
- Tick: `guarded(result, "release-commissions", ...)` com `PLATFORM_IDENTITY`, chamando `select release_due_commissions()`; soma em `commissionsReleased`.
- TS LGPD: `"commission"` em `CLIENT_FAILURES`, `AnonymizeClientFailure` e `FAILURE_MESSAGES` ("Você tem saldo de comissão ou saque em aberto. Saque o saldo antes de pedir a exclusão.").

- [ ] **Step 1: Testes que falham** (`commission.integration.test.ts`; valores exatos):
  - pedido online de indicado, preço 1000,00, custo 600,00, % 10 → comissão 40,00 `pending`, accrual 360,00, carteira do afiliado pending 40,00.
  - % 100 → comissão 400,00, sem accrual; margem 0 → sem comissão; pedido de balcão → sem comissão; comprador sem vínculo → sem comissão.
  - captura repetida → uma comissão só.
  - afiliado anonimizado → sem comissão (Review Focus 1).
  - % alterada depois da captura → comissão gravada igual; pedido seguinte usa a % nova (Review Focus 5).
  - `release_due_commissions()` com `release_at` no passado → available 40,00, status `released`; no futuro → nada.
  - estorno de recarga do indicado com falta de 30,00 depois do clawback → reverte 30,00 da comissão pendente, `refund_shortfall` = 0, comissão `pending` com `reversed_amount` 30,00; estorno depois de `released` → nada revertido, `refund_shortfall` igual (Review Focus 4).
  - LGPD: anonimizar afiliado com saldo → `commission`.
- [ ] **Step 2:** `npx vitest run src/lib/affiliates/commission.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implemente a 027 e o TS. `db:reset`.
- [ ] **Step 4:** mesmo comando → PASS; `npx vitest run src/lib src/actions` → PASS (inclui os testes de liquidação e webhook existentes); `npm run type-check`.
- [ ] **Step 5 (coordenador):** `feat(affiliates): comissão na captura com carência e reversão no estorno`

### Task 3: Saque e conversão em créditos

**Agent:** `database-architect` · **Depends-on:** Task 1, Task 2
**Files:**
- Create: `db/migrations/028_affiliate_withdrawals.sql`, `src/lib/affiliates/withdrawals.ts`, `src/lib/affiliates/withdrawals.integration.test.ts`, `src/actions/affiliate-withdrawals.ts`, `src/actions/affiliate-withdrawals.test.ts`
- Modify: `src/lib/db/rls.integration.test.ts`

**Interfaces:**
- `affiliate_withdrawals (id uuid pk, bureau_id, profile_id, amount numeric(15,2) check (amount > 0), fee numeric(15,2) check (fee >= 0), net numeric(15,2) check (net > 0), pix_key_type text check (pix_key_type in ('document','email','phone','random')), pix_key text not null, holder_name text not null, status text check (status in ('open','paid','cancelled')), cancel_reason text, receipt_object_key, receipt_mime, receipt_sha256, paid_at, paid_by, created_at)`; índice único parcial `(profile_id) where status = 'open'`; CHECKs de pago/cancelado no padrão de `payouts` (016). RLS: cliente lê os próprios sem `pix_key` completa (view ou função que mascara); superadmin lê via função de detalhe.
- Funções (`security definer`):
  - `request_affiliate_withdrawal(p_amount numeric, p_pix_key_type text, p_pix_key text) returns table (ok boolean, reason text, withdrawal_id uuid)`: papel `client`; taxa de `settings.affiliate_withdrawal_fee`: `v_fee := round(fixed + percent * p_amount / 100, 2)`, `v_net := p_amount - v_fee`; `v_net <= 0` → `net_not_positive`; saque aberto → `withdrawal_open`; `withdrawal_hold` → falta → `insufficient_funds`; `holder_name` = nome da conta; auditoria `withdrawal.request` (sem chave).
  - `get_affiliate_withdrawal_detail(p_id uuid) returns table (...com pix_key completa e holder_name)`: só superadmin fora de suporte; grava `withdrawal.view` (sem chave).
  - `mark_affiliate_withdrawal_paid(p_id uuid, p_object_key text, p_mime text, p_sha256 text) returns table (ok boolean, reason text, status text)`: só superadmin; `open` → `paid`; `withdrawal_paid`; idempotente se já pago.
  - `cancel_affiliate_withdrawal(p_id uuid, p_reason text) returns table (ok boolean, reason text, status text)`: só superadmin; `open` → `cancelled`; `withdrawal_release`.
  - `convert_affiliate_commission(p_amount numeric) returns table (ok boolean, reason text)`: papel `client`; `conversion` na carteira de comissão e `client_wallet_post_entry(..., 'commission_credit', ...)` na mesma transação; chave de idempotência por requisição (`p_request_id uuid` gerado na action).
- `src/lib/affiliates/withdrawals.ts`: `requestWithdrawal`, `convertCommission`, `listMyWithdrawals`, `listWithdrawalQueue`, `getWithdrawalDetail`, `markWithdrawalPaid`, `cancelWithdrawal` — wrappers finos com `{ ok: false, reason }`.
- `src/actions/affiliate-withdrawals.ts`: `requestWithdrawalAction(values)`, `convertCommissionAction(values)` (`affiliates:read`); `markWithdrawalPaidAction(formData)` (reusa `storePayoutReceipt`, `src/lib/payouts/receipt.ts:62`; descarta o arquivo se a função recusar), `cancelWithdrawalAction(values)` (`withdrawals:manage`). zod: chave PIX por tipo (documento = CPF/CNPJ válido; e-mail; telefone E.164; aleatória = UUID); declaração "a chave está no meu nome" obrigatória. Mensagens pt-BR por motivo.

- [ ] **Step 1: Testes que falham**:
  - taxa fixo 2,00 + 1% sobre 100,00 → fee 3,00, net 97,00, available −100,00.
  - net ≤ 0 → `net_not_positive`; segundo saque aberto → `withdrawal_open`; valor maior que o disponível → `insufficient_funds`; valor em carência não é sacável.
  - cancelar → available volta; marcar pago → `paid`, repetir → idempotente; cliente e Bureau não executam pagar/cancelar.
  - conversão 40,00 → comissão −40,00, créditos +40,00, sem taxa.
  - saque e conversão em paralelo sobre 50,00 disponíveis pedindo 40,00 cada → um `ok`, o outro `insufficient_funds`; saldo nunca negativo (Review Focus 3).
  - detalhe do superadmin grava `withdrawal.view` sem a chave no metadata; cliente vê a chave mascarada.
  - action: sem a declaração → erro e nada gravado; chave e-mail inválida → erro.
- [ ] **Step 2:** `npx vitest run src/lib/affiliates/withdrawals.integration.test.ts src/actions/affiliate-withdrawals.test.ts` → FAIL.
- [ ] **Step 3:** Implemente. Se a Tarefa 2 deixou a checagem de saque aberto da LGPD para cá, complete-a nesta migration (redefinindo `lgpd_anonymize_client_account`).
- [ ] **Step 4:** mesmo comando → PASS; `npx vitest run src/lib src/actions` → PASS; `npm run type-check`.
- [ ] **Step 5 (coordenador):** `feat(affiliates): saque com taxa e conversão do saldo em créditos`

### Task 4: Cadastro pelo link, % do Bureau e configuração do superadmin (backend)

**Agent:** `backend-specialist` · **Depends-on:** Task 1
**Files:**
- Modify: `src/app/b/[slug]/cadastro/page.tsx` (ler `searchParams.ref` e passar ao form), `src/components/register/register-form.tsx` (campo oculto), `src/lib/validators/register.ts` (`referralCode: z.string().regex(/^[a-z0-9]{8}$/).optional()`; valor inválido vira `undefined`, sem erro), `src/actions/register.ts`, `src/lib/settings/readers.ts`, `src/actions/settings.ts`
- Create: `src/lib/affiliates/rates.ts`, `src/actions/affiliates-bureau.ts`, `src/lib/affiliates/rates.integration.test.ts`, `src/actions/affiliates-bureau.test.ts`

**Interfaces:**
- `readAffiliateSettings(identity: DbIdentity): Promise<{ holdDays: number; withdrawalFee: { fixed: string; percent: string } }>` (padrões 30 e 0/0) em `readers.ts`.
- `saveAffiliateSettings(values: unknown): Promise<SaveResult>` em `src/actions/settings.ts` (superadmin, `settings:write`; `holdDays` inteiro 0–365; `fixed` ≥ 0; `percent` 0–100; `upsertSettings` com auditoria `settings.affiliates`).
- `src/lib/affiliates/rates.ts`: `listBureauAffiliates(identity): Promise<{ profileId: string; name: string; code: string; referrals: number; pct: string | null; totalCommission: string }[]>`; `setBureauDefaultPct(identity, pct: string)`; `setAffiliatePct(identity, affiliateProfileId: string, pct: string | null)` (`null` remove a % própria). Escrita com auditoria `affiliate.rate`; RLS do Bureau.
- `src/actions/affiliates-bureau.ts`: `setDefaultPctAction(values)`, `setAffiliatePctAction(values)` (`affiliates:manage`).
- O link do afiliado: `${config.betterAuthUrl}/b/${slug}/cadastro?ref=${code}` (helper `affiliateLink(slug, code)` em `rates.ts` ou `queries.ts` da Tarefa 1 — use um só e exporte).

- [ ] **Step 1: Testes que falham**:
  - `registerClientAction` com `referralCode` válido grava o vínculo; com `ref` malformado o cadastro conclui sem vínculo.
  - Bureau define padrão 5% e 10% para um afiliado → `listBureauAffiliates` mostra 10% para ele e `null` (usa padrão) para os outros; outro Bureau não altera; pct 101 → erro.
  - superadmin salva hold 15 e taxa {2, 1}; `readAffiliateSettings` devolve os valores; Bureau não consegue salvar.
- [ ] **Step 2:** `npx vitest run src/lib/affiliates/rates.integration.test.ts src/actions/affiliates-bureau.test.ts src/actions/register.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implemente.
- [ ] **Step 4:** mesmo comando → PASS; `npm run type-check`.
- [ ] **Step 5 (coordenador):** `feat(affiliates): cadastro pelo link, % do Bureau e configuração da taxa`

### Task 5: Telas do cliente — saldos, afiliação e saque

**Agent:** `frontend-specialist` · **Depends-on:** Task 1, Task 3, Task 4
**Files:**
- Modify: `src/app/(portal)/portal/page.tsx` (cards de saldo: créditos disponíveis; comissão disponível e em carência), `src/app/(portal)/layout.tsx` (link "Afiliação")
- Create: `src/app/(portal)/portal/afiliacao/page.tsx`, `src/app/(portal)/portal/afiliacao/saque/page.tsx`, `src/components/affiliates/affiliate-link-card.tsx`, `src/components/affiliates/commission-table.tsx`, `src/components/affiliates/withdrawal-form.tsx`, `src/components/affiliates/convert-form.tsx`, `src/components/affiliates/affiliate-rules.ts`, `src/components/affiliates/affiliate-rules.test.ts`

**Interfaces:**
- Consumes: `getMyAffiliateSummary` (T1), `affiliateLink` (T4), `readAffiliateSettings` (T4), `requestWithdrawalAction`, `convertCommissionAction`, `listMyWithdrawals` (T3), `getClientWallet` (`src/lib/wallet/client-queries.ts:25`).
- Afiliação: link com botão copiar; tabela de indicados (nome, data, total gasto); tabela de comissões (data, indicado, produto, valor do pedido, comissão, status "Em carência até dd/mm" / "Disponível" / "Revertida"); botão "Usar como crédito".
- Saque: taxa vigente em texto ("Taxa de saque: R$ X + Y%"), valor, tipo e chave PIX, checkbox "A chave PIX está no meu nome", prévia do líquido; lista dos saques com chave mascarada e status.
- `affiliate-rules.ts` (funções puras): `withdrawalPreview(amount: string, fee: { fixed: string; percent: string }): { fee: string; net: string; valid: boolean }`; `commissionStatusLabel(status, releaseAt): string`.

- [ ] **Step 1: Testes que falham** (`affiliate-rules.test.ts`): `withdrawalPreview("100.00", {fixed:"2.00", percent:"1"})` → `{ fee: "3.00", net: "97.00", valid: true }`; `withdrawalPreview("2.00", {fixed:"2.00", percent:"0"})` → `valid: false`; rótulos dos 3 status.
- [ ] **Step 2:** `npx vitest run src/components/affiliates` → FAIL.
- [ ] **Step 3:** Implemente (invoque `/vercel:shadcn` e `/ui-ux-pro-max` antes; sem dependência nova).
- [ ] **Step 4:** mesmo comando → PASS; `npm run type-check`; `npm run lint`.
- [ ] **Step 5 (coordenador):** `feat(ui): saldos no portal, tela de afiliação e de saque`

### Task 6: Telas do Bureau e do superadmin

**Agent:** `frontend-specialist` · **Depends-on:** Task 3, Task 4
**Files:**
- Modify: `src/app/(dashboard)/page.tsx` (cards: saldo da carteira pré-paga via `getWallet`, `src/lib/wallet/queries.ts:114`; a receber via `getPayableBalance`, `src/lib/payables/queries.ts:21`), `src/components/layout/sidebar.tsx` e `src/components/layout/nav-items.ts` ("Afiliados", permissão `affiliates:manage`), `src/components/superadmin/superadmin-nav.tsx` ("Saques"), `src/app/(superadmin)/superadmin/settings/page.tsx` (link para a configuração de afiliados)
- Create: `src/app/(dashboard)/afiliados/page.tsx`, `src/components/affiliates/bureau-affiliates-table.tsx`, `src/app/(superadmin)/superadmin/saques/page.tsx`, `src/app/(superadmin)/superadmin/saques/[id]/page.tsx`, `src/app/(superadmin)/superadmin/settings/afiliados/page.tsx`, `src/components/affiliates/withdrawal-queue-rules.ts`, `src/components/affiliates/withdrawal-queue-rules.test.ts`

**Interfaces:**
- Consumes: `listBureauAffiliates`, `setDefaultPctAction`, `setAffiliatePctAction`, `readAffiliateSettings`, `saveAffiliateSettings` (T4); `listWithdrawalQueue`, `getWithdrawalDetail`, `markWithdrawalPaidAction`, `cancelWithdrawalAction` (T3).
- Bureau: % padrão editável; tabela de afiliados (nome, código, indicados, % própria ou "padrão", total de comissão) com edição da %.
- Superadmin: fila de saques abertos; detalhe com chave completa, nome do titular, valor, taxa, líquido, aviso "Confira no banco se o nome do favorecido é o mesmo da conta"; upload do comprovante (PDF/PNG/JPEG, 5 MB) para marcar pago; cancelar com motivo; página de configuração (carência em dias, taxa fixa, taxa %).
- `withdrawal-queue-rules.ts`: `canActOnWithdrawal(status): boolean` (só `open`).

- [ ] **Step 1: Testes que falham** (`withdrawal-queue-rules.test.ts`): `open` → true; `paid`, `cancelled` → false.
- [ ] **Step 2:** `npx vitest run src/components/affiliates/withdrawal-queue-rules.test.ts` → FAIL.
- [ ] **Step 3:** Implemente (invoque `/vercel:shadcn` e `/ui-ux-pro-max` antes).
- [ ] **Step 4:** `npx vitest run src/components`; `npm run type-check`; `npm run lint`.
- [ ] **Step 5 (coordenador):** `feat(ui): afiliados do Bureau, fila de saques e configuração do superadmin`

### Task 7: E2E e documentos

**Agent:** `qa-automation-engineer` · **Depends-on:** Task 5, Task 6
**Files:**
- Create: `e2e/affiliate.spec.ts`
- Modify: `e2e/fixtures.ts`, `PRODUCT.md` (tirar "comissão" de "Fora de escopo"; seção do programa de afiliados), `docs/architecture.md` (migrations 026–028), `docs/operations/affiliates.md` (novo runbook: carência, fila de saques, como pagar, cancelar, validação fiscal pendente)

**Interfaces:**
- E2E: o cliente A copia o link; o cliente B se cadastra pelo link e compra online; depois da captura, A vê a comissão "Em carência"; o teste força `release_at` no passado e roda o tick; A converte parte em crédito e pede saque do resto; o superadmin vê a fila e marca pago com um PDF.

- [ ] **Step 1:** Escreva o spec e ajuste fixtures.
- [ ] **Step 2:** `npm run test:e2e -- affiliate` e a suíte e2e completa → PASS.
- [ ] **Step 3:** Atualize os documentos (STE, pt-BR).
- [ ] **Step 4:** `npm run check` → verde (recrie `credit_system_test` antes: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system_test npm run db:reset`).
- [ ] **Step 5 (coordenador):** `test(e2e): fluxo de afiliado; docs`

## Ondas

| Onda | Tarefas | Motivo |
|---|---|---|
| 1 | 1 | base de tudo |
| 2 | 2, 4 | dependem só de 1; 4 não tem SQL, arquivos disjuntos |
| 3 | 3 | SQL (028) e depende de 2 para a checagem LGPD; serial com 2 porque o runner aplica todas as migrations da árvore |
| 4 | 5, 6 | telas; arquivos disjuntos |
| 5 | 7 | fim |

Revisão única no fim (`code-reviewer` + `security-reviewer`). Post-deploy: contador valida o tratamento fiscal do saque antes de liberar a funcionalidade.
