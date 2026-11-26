# Pagamento por pedido — Plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development`. Implementadores não commitam sozinhos: o coordenador commita uma vez por tarefa, em ordem, com o HEAD capturado antes de cada commit. Passos usam checkbox (`- [ ]`).

**Goal:** O cliente preenche o pedido, o sistema calcula o valor e abre a tela de PIX. Quando o webhook confirma o PIX, o pedido segue sozinho: sem recarga prévia e sem preencher de novo.

**Architecture:** Abordagem A. `placeOrder` online tenta a reserva como hoje. Se o saldo não cobre o preço, o pedido fica em `awaiting_payment` e o preço pago e o cupom ficam em `order_pix_quotes`. A cobrança Pix do pedido é uma linha de `pix_charges` com `order_id`, criada por `runCheckout`. No webhook, `apply_asaas_payment` desvia para `apply_order_pix_charge`: numa transação, credita a carteira do cliente com o preço, monta o contexto do cliente, chama `reserve_order` com o preço guardado e chama `refresh_order_state`. Carteira, livro, `capture_order`, comissão de afiliado e cupom ficam intactos. Reserva recusada depois do pagamento deixa o valor como saldo e o tick cancela o pedido.

**Tech Stack:** Next.js 14.2 (App Router), TypeScript, `pg` (SQL puro), PostgreSQL com RLS, vitest, Playwright, Asaas (driver `fake` nos testes).

**Spec:** `docs/superpowers/specs/2026-11-26-fluxo-cliente-final-design.md` (Parte 2, corrigida neste plano).

**Depende de:** Parte 1 (`docs/superpowers/plans/2026-11-26-fluxo-cliente-1-cadastro-sem-email.md`) já integrada. Ela remove as travas de e-mail em `src/actions/orders-client.ts` e `src/lib/payments/checkout.ts`. Este plano não toca nessas travas.

## Correções à spec (conferidas no código)

- `reserve_order` (055:840) recusa sem contexto de cliente: exige `app_context_present()`, `app_user_role() = 'client'` e `p_client_profile_id = app_user_id()`, e lê `app_bureau_id()`. O webhook roda como `app_webhook`, sem sessão. Por isso o ramo novo monta o contexto do cliente com `set_config(..., true)` e o restaura no fim.
- `reserve_order` com cupom confere o limite de tentativas por hora (054). Com o contexto montado, o cliente bloqueado por erros de código teria o cupom pago recusado. O ramo novo usa uma vaga de transação (`app.coupon_slot`), como `placeOrder`.
- `pix_charges_link_shape_check` (058) não muda: a cobrança do pedido tem `payment_link_id` nulo.
- `open_order` (055:394) não muda. Ele grava o pedido online em `awaiting_authorization` e chama `refresh_order_state`. O ramo online novo de `refresh_order_state` (pago = liquidação `reserved` ou `captured`) põe o pedido sem reserva em `awaiting_payment`. O guard de `dossier_orders` já aceita `awaiting_authorization -> awaiting_payment` e `awaiting_payment -> awaiting_authorization | ready | cancelled`.
- "Preço guardado no pedido": `dossier_orders` não aceita coluna nova mutável sem mudar o `open_order` de 450 linhas. O preço e o cupom vão para a tabela nova `order_pix_quotes`.
- "Valor menor não reserva nada": também não credita (regra da recarga, `amount_mismatch`). Valor maior credita o preço da cobrança (regra da recarga).
- `cancelOrder` lança quando `release_order` responde `not_found`. Pedido online em `awaiting_payment` não tem liquidação. `cancelOrder` passa a aceitar esse caso.
- O tick só emite pedido de autorização SCR para pedido em `awaiting_authorization` (`tick-queries.ts`, `listScrRequestsToIssue`). O pedido que espera o PIX não manda e-mail a terceiros. Nada muda aqui.
- Limite mínimo: `pix_charges.amount` aceita só R$ 10,00 a R$ 5.000,00 (012:60). Preço com cupom entre R$ 0,01 e R$ 9,99 sem saldo também precisa de erro claro.

## Decisões de projeto (assumidas; veja "Perguntas ao dono do produto")

- D1. Saldo que cobre o preço: reserva direta, sem PIX (caminho de hoje). É o que torna utilizável o saldo deixado por uma reserva recusada. Os testes E2E atuais continuam válidos.
- D2. Saldo menor que o preço: PIX do preço inteiro (não da diferença).
- D3. Taxa do PIX (`PIX_FEE_CENTS`) repassada como na recarga: o pagador paga preço + taxa; a carteira recebe o preço.
- D4. Um PIX vivo por pedido. PIX vencido não gera outro: o pedido é cancelado. A cobrança que o Asaas recusou (`cancelled`) pode ser refeita.
- D5. PIX pago depois do cancelamento do pedido vira saldo (`order_not_payable`).

## Global Constraints

- Migrations: `db/migrations/063_order_pix_schema.sql` e `db/migrations/064_order_pix_webhook.sql`. A Parte 1 usa a `062`. Rode `ls db/migrations` antes: se o número estiver ocupado, use o próximo livre nos dois arquivos e neste plano. Nunca editar 001-062.
- `create or replace` mantém dono e grants: `refresh_order_state` (dono `schema_owner`, execute `app_runtime`, `auth_profile_lookup`); `apply_asaas_payment` (dono `auth_profile_lookup`, execute só `app_webhook`).
- Função nova `apply_order_pix_charge`: `security definer`, `set search_path = pg_catalog, public`, dono `auth_profile_lookup`, `revoke all ... from public`, sem grant (só `apply_asaas_payment` a chama).
- SQL parametrizado. Query do app em `withUserTransaction({ userId, role, bureauId }, fn)`. `PoolClient` não sai do módulo de queries.
- Action: zod `safeParse`, depois sessão e `hasPermission(session, "portal:write")` (via `requireClient`), depois query, depois `revalidatePath`. Retorno `{ error: string | null, id? }`.
- Auditoria na mesma transação de cada mutação.
- Nunca CPF/CNPJ completo em log, auditoria, erro ou export. Log do webhook: só evento e ids.
- Nenhuma chamada HTTP (Asaas) dentro de transação.
- Dinheiro: centavos inteiros no TypeScript (`toCents`, `fromCents`); `numeric(15,2)` no SQL.
- Faixa do PIX: `MIN_TOPUP_CENTS = 1000`, `MAX_TOPUP_CENTS = 500000` (`src/lib/validators/wallet.ts`). Validade: `PIX_CHARGE_TTL_MINUTES = 30`. Folga nova: `ORDER_PIX_GRACE_MINUTES = 15`.
- Texto de interface, erro e comentário em pt-BR. Identificadores em inglês. Import com `@/`.
- Testes ao lado do código. `*.integration.test.ts` usa Postgres real em `127.0.0.1:54329` (`docker-compose.dev.yml`).
- Comandos: `npm run test`, `npm run type-check`, `npm run lint`, `npm run db:migrate`.
- Commit convencional, uma linha, pelo coordenador. Sem push. Depois de cada commit de código: `graphify update .`.
- Implementadores: `model: sonnet`. Nunca `opus`.

## Review Focus

Modos de falha que nenhum teste isolado de tarefa pega sozinho. O teste de cada um está na tarefa dona.

1. **Contexto de cliente vazando do webhook.** `apply_order_pix_charge` troca `app.user_id`, `app.user_role`, `app.bureau_id`, `app.support_session_id` e `app.coupon_slot`. Se não restaurar, o resto da transação roda como o cliente. Teste: T2 `restores the app context after the order branch`.
2. **Deadlock cupom x carteira.** O crédito trava a carteira do cliente antes de `reserve_order` travar o cupom; `placeOrder` trava cupom e depois carteira. O ramo novo pega a trava do cupom antes do crédito. Teste: T2 `takes the coupon lock before crediting the wallet`.
3. **Corrida tick x webhook.** O tick cancela o pedido enquanto o webhook paga. Resultado aceito: ou o pedido avança, ou o valor fica como saldo; nunca reserva presa em pedido cancelado. Teste: T5 `tick cancel and webhook payment never leave a reservation on a cancelled order`.
4. **Regressão dos pedidos online antigos.** O ramo online novo de `refresh_order_state` não pode rebaixar pedido com reserva. Teste: T1 `refresh keeps an online order with a reserved settlement` e a consulta em "Post-deploy follow-up".
5. **Valor da cobrança vindo do navegador.** A cobrança do pedido só nasce com o valor de `order_pix_quotes`. Teste: T1 `rejects an order charge with an amount different from the quote` e T4 `createOrderPixAction ignores the browser amount`.

---

## Tarefa 1: Esquema do PIX do pedido e estado online

**Files:**
- Criar: `db/migrations/063_order_pix_schema.sql`
- Criar: `src/lib/orders/order-pix-schema.integration.test.ts`

**Depends-on:** nenhuma.
**Agent:** `database-architect`. **Model:** `sonnet`.

**Interfaces:**
- Produz a tabela `order_pix_quotes`, a coluna `pix_charges.order_id`, o novo `refresh_order_state` e o motivo `payment_not_reserved`.
- Consome `order_settlements`, `dossier_orders`, `pix_charges`, as funções `app_*` (004).

**SQL exato (a forma é o requisito):**

```sql
-- Pagamento por pedido (spec 2026-11-26-fluxo-cliente-final-design.md, Parte 2). A 001-062 já foram aplicadas e não mudam.
-- 1) order_pix_quotes: preço pago e cupom do pedido online que espera o PIX. Imutável (sem update nem delete).
-- 2) pix_charges.order_id: cobrança Pix do pedido. No máximo uma viva (pending ou paid) por pedido; valor = preço guardado.
-- 3) refresh_order_state: ramo online (pago = liquidação reserved ou captured).
-- 4) dossier_orders.state_reason: payment_not_reserved (PIX pago, reserva recusada, valor ficou como saldo).

create table order_pix_quotes (
  dossier_id uuid primary key references dossier_orders (dossier_id),
  bureau_id uuid not null references bureaus (id),
  client_profile_id uuid not null,
  price numeric(15,2) not null check (price >= 10.00 and price <= 5000.00),
  coupon_code text check (coupon_code is null or (btrim(coupon_code) <> '' and length(coupon_code) <= 64)),
  created_at timestamptz not null default now(),
  foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id)
);
alter table order_pix_quotes enable row level security;
alter table order_pix_quotes force row level security;
grant select on order_pix_quotes to app_runtime, auth_profile_lookup, backup_reader;
grant insert (dossier_id, bureau_id, client_profile_id, price, coupon_code) on order_pix_quotes to app_runtime;

create policy order_pix_quotes_select_own on order_pix_quotes for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id());
create policy order_pix_quotes_select_staff on order_pix_quotes for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy order_pix_quotes_insert_own on order_pix_quotes for insert with check (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
  and exists (select 1 from dossier_orders o
               where o.dossier_id = order_pix_quotes.dossier_id and o.bureau_id = order_pix_quotes.bureau_id
                 and o.client_profile_id = order_pix_quotes.client_profile_id
                 and o.mode = 'online' and o.state = 'awaiting_payment'));
create policy order_pix_quotes_gateway_select on order_pix_quotes for select to auth_profile_lookup using (true);

alter table pix_charges add column order_id uuid references order_pix_quotes (dossier_id);
alter table pix_charges add constraint pix_charges_order_shape_check check (
  order_id is null or (client_profile_id is not null and payment_link_id is null and billing_type = 'PIX'));
-- Um PIX vivo por pedido. A cobrança que o Asaas recusou (cancelled) sai do índice e pode ser refeita.
create unique index pix_charges_order_live_idx on pix_charges (order_id) where status in ('pending', 'paid');
grant insert (order_id) on pix_charges to app_runtime;
-- Restritiva: soma-se a pix_charges_client_insert. Cobrança de pedido só do próprio cliente, com o preço guardado,
-- e só com o pedido aguardando pagamento.
create policy pix_charges_order_insert_guard on pix_charges as restrictive for insert to app_runtime with check (
  order_id is null or exists (
    select 1 from order_pix_quotes q join dossier_orders o on o.dossier_id = q.dossier_id
     where q.dossier_id = pix_charges.order_id and q.bureau_id = pix_charges.bureau_id
       and q.client_profile_id = pix_charges.client_profile_id and q.price = pix_charges.amount
       and o.state = 'awaiting_payment'));

alter table dossier_orders drop constraint dossier_orders_state_reason_check;
alter table dossier_orders add constraint dossier_orders_state_reason_check
  check (state_reason is null or state_reason in ('scr_refused', 'scr_expired', 'payment_timeout',
    'cancelled_by_staff', 'cancelled_by_client', 'deps_no_data', 'deps_incompatible', 'deps_unavailable',
    'reservation_clawed_back', 'payment_not_reserved'));
```

`refresh_order_state`: `create or replace` com o corpo da 022 (linhas 114-148). Só muda o bloco do pagamento:

```sql
  if v_o.mode = 'counter' then
    select s.price into v_price from public.order_settlements s where s.order_ref = p_dossier_id;
    select coalesce(sum(p.amount), 0) into v_paid from public.counter_payments p
     where p.dossier_id = p_dossier_id and p.voided_at is null;
    v_paid_ok := v_price is not null and v_paid >= v_price;
  else
    -- Online: pago = reserva feita (do saldo em placeOrder ou do PIX do pedido em apply_order_pix_charge, 064).
    v_paid_ok := exists (select 1 from public.order_settlements s
                          where s.order_ref = p_dossier_id and s.status in ('reserved', 'captured'));
  end if;
```

Todos os chamadores atuais leem `order_settlements` pela RLS: cliente (`order_settlements_select_own`), equipe e tick (`_select_staff`), funções definer (`_gateway_select`).

**Steps:**

- [ ] Escrever `src/lib/orders/order-pix-schema.integration.test.ts` (modelo de setup: `src/lib/orders/coupon.integration.test.ts`). Casos e asserções:
  - `open_order online without settlement lands in awaiting_payment`: cliente sem saldo chama `open_order`; `state = 'awaiting_payment'`.
  - `refresh moves a paid online order out of awaiting_payment`: depois de `reserve_order` com saldo, `refresh_order_state` devolve `awaiting_authorization` (ou `ready` com autorização válida).
  - `refresh keeps an online order with a reserved settlement`: pedido aberto pelo caminho de hoje (saldo suficiente) continua em `awaiting_authorization` depois de `refresh_order_state`.
  - `client inserts a quote only for an own online order awaiting payment`: insert do próprio passa; pedido de outro cliente falha com `42501`; pedido em `awaiting_authorization` falha com `42501`.
  - `client never reads another client's quote`: `select` do cliente B devolve 0 linhas.
  - `quote price outside 10.00..5000.00 is rejected`: `9.99` e `5000.01` falham com `23514`.
  - `rejects an order charge with an amount different from the quote`: insert em `pix_charges` com `order_id` e `amount <> price` falha com `42501`.
  - `rejects an order charge for another client's order`: `42501`.
  - `rejects a second live charge for the same order`: segunda linha `pending` falha com `23505`; depois de marcar a primeira `cancelled` (como dono), a nova passa.
  - `rejects an order charge with billing CREDIT_CARD`: `23514`.
  - `quote is immutable`: `update` e `delete` como `app_runtime` falham (`42501`).
- [ ] Rodar `npm run test -- src/lib/orders/order-pix-schema.integration.test.ts`. Ver falhar (tabela e coluna não existem).
- [ ] Escrever `063_order_pix_schema.sql` com o SQL acima. Rodar `npm run db:migrate`.
- [ ] Rodar o teste de novo e ver passar. Rodar também `src/lib/orders/*.integration.test.ts` e `src/lib/payment-links/*.integration.test.ts` (regressão do `refresh_order_state`).
- [ ] Commit: `feat(db): esquema do PIX do pedido e estado online aguardando pagamento`.

---

## Tarefa 2: Webhook do PIX do pedido

**Files:**
- Criar: `db/migrations/064_order_pix_webhook.sql`
- Criar: `src/lib/orders/order-pix-webhook.integration.test.ts`

**Depends-on:** T1.
**Agent:** `database-architect`. **Model:** `sonnet`.

**Interfaces:**
- Produz `apply_order_pix_charge(p_charge_id uuid, p_payload jsonb) returns text` e os resultados novos `order_paid`, `order_reserve_failed`, `order_not_payable`.
- `apply_asaas_payment(text, text, text, jsonb)`: corpo igual ao da 058 (linhas 309-564), mais um ramo.
- Consome `reserve_order` (055), `client_wallet_post_entry` (031), `refresh_order_state` (063), `coupon_attempt_misses` (052/054).

**SQL exato (contrato e travas):**

```sql
-- Baixa do PIX de pedido online (063). Chamada só por apply_asaas_payment, já com o evento gravado. Numa transação:
-- confere o valor, marca a cobrança paga, credita o preço na carteira do cliente e, com o pedido aguardando pagamento,
-- reserva o pedido com o preço e o cupom guardados e atualiza o estado. Reserva recusada: o preço fica como saldo e o
-- tick cancela o pedido (payment_not_reserved). Estorno não passa aqui: segue o ramo do cliente de apply_asaas_payment.
-- Ordem de travas: cobrança -> pedido -> cupom (advisory, a mesma de reserve_order) -> carteira do cliente ->
-- (reserve_order: liquidação -> carteira do cliente -> repasse -> carteira do Bureau).
alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch',
    'link_paid', 'link_duplicate', 'link_ignored', 'link_order_not_payable', 'link_refund_ignored',
    'link_overpaid', 'order_paid', 'order_reserve_failed', 'order_not_payable'));

-- Auditoria do ramo do pedido: só o dono das funções, só estas ações, só junto da cobrança paga ou da liquidação nova.
create policy audit_logs_order_pix_insert on audit_logs for insert to auth_profile_lookup with check (
  support_session_id is null and bureau_id is not null and (
    (action = 'order.pix_paid' and table_name = 'pix_charges' and exists (
       select 1 from pix_charges c
        where c.id = audit_logs.record_id and c.order_id is not null and c.status = 'paid'
          and c.bureau_id = audit_logs.bureau_id and c.requested_by = audit_logs.user_id))
    or (action = 'settlement.reserve' and table_name = 'order_settlements' and exists (
       select 1 from order_settlements s
        where s.id = audit_logs.record_id and s.mode = 'online' and s.bureau_id = audit_logs.bureau_id
          and s.client_profile_id = audit_logs.user_id and s.created_at = now()))));

create function apply_order_pix_charge(p_charge_id uuid, p_payload jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_order public.dossier_orders;
  v_quote public.order_pix_quotes;
  v_paid numeric;
  v_post record;
  v_res record;
  v_coupon uuid;
  v_slot uuid;
  v_settlement uuid;
  v_reason text;
  v_result text;
  v_prev_user text := coalesce(current_setting('app.user_id', true), '');
  v_prev_role text := coalesce(current_setting('app.user_role', true), '');
  v_prev_bureau text := coalesce(current_setting('app.bureau_id', true), '');
  v_prev_support text := coalesce(current_setting('app.support_session_id', true), '');
  v_prev_slot text := coalesce(current_setting('app.coupon_slot', true), '');
begin
  select * into v_charge from public.pix_charges where id = p_charge_id and order_id is not null for update;
  if v_charge.id is null or v_charge.status = 'cancelled' then
    return 'ignored';
  end if;
  if v_charge.status in ('paid', 'refunded') then
    return 'duplicate';
  end if;
  -- Regra da recarga (045/050): abaixo do total esperado não credita; sem valor numérico ou acima credita amount.
  v_paid := case when (p_payload -> 'payment' ->> 'value') ~ '^-?\d+(\.\d+)?$'
    then (p_payload -> 'payment' ->> 'value')::numeric end;
  if v_paid is not null and v_paid < coalesce(v_charge.total_charged, v_charge.amount) then
    return 'amount_mismatch';
  end if;

  select * into strict v_order from public.dossier_orders where dossier_id = v_charge.order_id for update;
  select * into strict v_quote from public.order_pix_quotes where dossier_id = v_charge.order_id;
  if v_quote.coupon_code is not null then
    select c.id into v_coupon from public.coupons c
     where c.bureau_id = v_charge.bureau_id and c.code = upper(btrim(v_quote.coupon_code));
    if v_coupon is not null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coupon:' || v_coupon::text, 0));
    end if;
  end if;

  update public.pix_charges set status = 'paid' where id = v_charge.id;
  select * into v_post from public.client_wallet_post_entry(
    v_charge.client_profile_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
    'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
  if not v_post.ok then
    raise exception 'wallet topup failed: %', v_post.reason;
  end if;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', 'client_ledger_entries', v_post.entry_id,
    jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id, 'order_id', v_charge.order_id,
      'amount', v_charge.amount::text));

  if v_order.mode <> 'online' or v_order.state <> 'awaiting_payment' or v_quote.price <> v_charge.amount then
    v_result := 'order_not_payable';
  else
    -- reserve_order só age com o contexto do cliente dono do pedido (055). Contexto local da transação, restaurado abaixo.
    perform set_config('app.user_id', v_charge.client_profile_id::text, true);
    perform set_config('app.user_role', 'client', true);
    perform set_config('app.bureau_id', v_charge.bureau_id::text, true);
    perform set_config('app.support_session_id', '', true);
    if v_quote.coupon_code is not null then
      -- O código foi conferido (e a tentativa contada) na abertura. A vaga evita que o limite por hora recuse o cupom já pago.
      insert into public.coupon_attempt_misses (profile_id, bureau_id)
      values (v_charge.client_profile_id, v_charge.bureau_id) returning id into v_slot;
      perform set_config('app.coupon_slot', v_slot::text, true);
    end if;
    select * into v_res from public.reserve_order(v_charge.order_id, 'online', v_charge.client_profile_id,
      v_quote.price, 0, '{"lines": []}'::jsonb, v_quote.coupon_code);
    if v_slot is not null then
      delete from public.coupon_attempt_misses where id = v_slot;
    end if;
    if v_res.ok then
      select s.id into v_settlement from public.order_settlements s where s.order_ref = v_charge.order_id;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.client_profile_id, 'settlement.reserve', 'order_settlements', v_settlement,
        jsonb_build_object('order_ref', v_charge.order_id, 'mode', 'online', 'status', 'reserved',
          'price', v_quote.price::text, 'source', 'asaas_webhook'));
      perform public.refresh_order_state(v_charge.order_id);
      v_result := 'order_paid';
    else
      v_reason := v_res.reason;
      v_result := 'order_reserve_failed';
    end if;
    perform set_config('app.user_id', v_prev_user, true);
    perform set_config('app.user_role', v_prev_role, true);
    perform set_config('app.bureau_id', v_prev_bureau, true);
    perform set_config('app.support_session_id', v_prev_support, true);
    perform set_config('app.coupon_slot', v_prev_slot, true);
  end if;

  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'order.pix_paid', 'pix_charges', v_charge.id,
    jsonb_build_object('order_id', v_charge.order_id, 'amount', v_charge.amount::text, 'result', v_result)
      || case when v_reason is not null then jsonb_build_object('reason', v_reason) else '{}'::jsonb end);
  return v_result;
end
$$;

alter function apply_order_pix_charge(uuid, jsonb) owner to auth_profile_lookup;
revoke all on function apply_order_pix_charge(uuid, jsonb) from public;
```

Ramo novo em `apply_asaas_payment`, logo depois do ramo `payment_link_id is not null`:

```sql
  elsif v_charge.order_id is not null and p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    -- PIX de pedido online (063): credita e reserva. Estorno e chargeback seguem o ramo do cliente abaixo.
    v_result := public.apply_order_pix_charge(v_charge.id, p_payload);
```

Nota para o implementador: `v_res` só é lido dentro do ramo que chamou `reserve_order` (registro não atribuído lança no plpgsql). Fora dele, o motivo vem de `v_reason`.

**Steps:**

- [ ] Escrever `src/lib/orders/order-pix-webhook.integration.test.ts` (modelos: `src/lib/payment-links/pix.integration.test.ts`, `src/lib/wallet/client-wallet.integration.test.ts`). Setup por SQL: pedido online sem saldo (`open_order`), `order_pix_quotes`, cobrança com `order_id` e `asaas_payment_id`. Chamar `applyAsaasPayment` (`src/lib/wallet/pix-charges.ts`). Casos e asserções:
  - `pays the order`: resultado `order_paid`; um lançamento `topup` de `price`; liquidação `reserved` com `price`; saldo disponível igual ao de antes; pedido em `awaiting_authorization`; auditorias `wallet.topup`, `settlement.reserve`, `order.pix_paid`.
  - `repeated event id is a duplicate`: mesmo `event_id` duas vezes; o segundo devolve `duplicate`; 1 `topup`, 1 liquidação.
  - `RECEIVED then CONFIRMED pays once`: ids de evento diferentes; o segundo devolve `duplicate`.
  - `lower value credits nothing`: `payment.value` = total - 0,01; `amount_mismatch`; cobrança `pending`; nenhum lançamento; pedido em `awaiting_payment`.
  - `higher value credits the price`: `payment.value` = total + 5; `order_paid`; `topup` = `price`.
  - `exhausted coupon after payment leaves balance`: cupom com `max_uses = 1` consumido por outro pedido depois da abertura; `order_reserve_failed`; saldo disponível sobe `price`; sem liquidação; redenções do cupom iguais; pedido em `awaiting_payment`; auditoria `order.pix_paid` com `reason = 'coupon_exhausted'`.
  - `coupon works for a client blocked by attempts`: 10 linhas em `coupon_attempt_misses` na última hora; `order_paid`; nenhuma vaga nova sobra.
  - `catalog price change after opening leaves balance`: nova versão de produto com outro `sale_price`; `order_reserve_failed` (`price_mismatch`).
  - `cancelled order keeps the money as balance`: pedido `cancelled` antes do webhook; `order_not_payable`; saldo sobe `price`; sem liquidação.
  - `restores the app context after the order branch`: numa transação como `app_webhook`, chamar `apply_asaas_payment` e ler `current_setting('app.user_id', true)` e `app.coupon_slot`: os valores de antes.
  - `takes the coupon lock before crediting the wallet`: conexão A segura `pg_advisory_xact_lock(hashtextextended('coupon:<id>', 0))`; webhook na conexão B fica esperando; na conexão C, nenhum `topup` da cobrança existe; A faz commit; B termina com `order_paid`.
  - `refund after reservation claws back on capture`: depois de `order_paid`, evento `PAYMENT_REFUNDED`; resultado `refunded`; `capture_order` do pedido devolve o ramo `reservation_clawed_back`.
  - `affiliate commission on capture is unchanged`: cliente indicado por afiliado; pedido pago por PIX e capturado gera a mesma comissão pendente que o pedido pago com saldo (modelo: `src/lib/affiliates/commission.integration.test.ts`).
- [ ] Rodar o arquivo. Ver falhar (função e resultados não existem).
- [ ] Escrever `064_order_pix_webhook.sql`. Rodar `npm run db:migrate`.
- [ ] Rodar o arquivo e ver passar. Rodar também `src/lib/wallet/*.integration.test.ts`, `src/lib/payment-links/*.integration.test.ts` e `src/lib/payments/coupon-clawback.integration.test.ts`.
- [ ] Commit: `feat(db): webhook do PIX do pedido credita e reserva numa transação`.

---

## Tarefa 3: Abertura do pedido com saldo ou PIX

**Files:**
- Modificar: `src/lib/orders/queries.ts` (só `placeOrder`, `PlaceOrderFailure`)
- Criar: `src/lib/orders/order-pix.ts`
- Modificar: `src/actions/orders-client.ts` (só `openClientOrderAction` e `ActionResult`)
- Modificar: `src/lib/orders/failure-messages.ts`
- Testes: `src/lib/orders/order-pix.integration.test.ts` (novo), `src/actions/orders-client.test.ts`

**Depends-on:** T1.
**Agent:** `backend-specialist`. **Model:** `sonnet`.

**Interfaces:**

```ts
// src/lib/orders/order-pix.ts
export async function insertOrderPixQuote(
	client: PoolClient,
	input: { dossierId: string; priceCents: number; couponCode: string | null },
): Promise<void>; // insert com app_bureau_id() e app_user_id(); price = fromCents(priceCents)

export type OrderPixCharge = {
	id: string;
	status: PixChargeStatus; // efetivo: pending vencida = expired
	pixPayload: string | null; // só enquanto pending e no prazo
	expiresAt: Date;
	createdAt: Date;
	amountCents: number;
	feeCents: number;
	totalCents: number; // total_charged ou amount
};
export type OrderPayment = { state: OrderState; priceCents: number; couponCode: string | null; charge: OrderPixCharge | null };
// Pedido + cotação + cobrança mais recente (por created_at). RLS: só o dono (ou a equipe) vê. Sem cotação: null.
export async function getOrderPayment(client: PoolClient, dossierId: string): Promise<OrderPayment | null>;

// src/lib/orders/queries.ts
export type PlaceOrderFailure =
	OpenOrderFailure | SettlementFailure | "declaration_outdated" | "pix_amount_above_limit" | "pix_amount_below_minimum";
export async function placeOrder(...): Promise<
	| { ok: true; dossierId: string; state: OrderState; pixPriceCents?: number }
	| { ok: false; reason: PlaceOrderFailure }
>;

// src/actions/orders-client.ts
export interface ActionResult { error: string | null; id?: string; paymentRequired?: true }
```

Ramo de dinheiro de `placeOrder` (forma exata), dentro da transação, no lugar de `if (!reserved.ok) throw ...`:

```ts
if (!reserved.ok) {
	// Online sem saldo: o pedido espera o PIX (abordagem A). Qualquer outra recusa desfaz tudo, como antes.
	if (mode !== "online" || reserved.reason !== "insufficient_balance") throw new PlaceOrderAbort(reserved.reason);
	const priceCents = quote.totalPriceCents - (coupon?.discountCents ?? 0);
	if (priceCents > MAX_TOPUP_CENTS) throw new PlaceOrderAbort("pix_amount_above_limit");
	if (priceCents < MIN_TOPUP_CENTS) throw new PlaceOrderAbort("pix_amount_below_minimum");
	await insertOrderPixQuote(client, { dossierId: opened.dossierId, priceCents, couponCode: coupon?.code ?? null });
	return { ok: true as const, dossierId: opened.dossierId, state: "awaiting_payment" as const, pixPriceCents: priceCents };
}
// open_order já chamou refresh_order_state antes da reserva: o online também precisa de um novo refresh.
const state = (await refreshOrderState(client, opened.dossierId)) ?? opened.state;
return { ok: true as const, dossierId: opened.dossierId, state };
```

- A vaga de cupom é devolvida também em `pix_amount_above_limit` e `pix_amount_below_minimum` (o código era válido), junto de `coupon_funds_insufficient`.
- Mensagens novas em `CLIENT_ORDER_MESSAGES`:
  - `pix_amount_above_limit`: "O valor passa do limite do PIX (R$ 5.000,00). Fale com o Bureau para pagar de outro jeito."
  - `pix_amount_below_minimum`: "O valor fica abaixo do mínimo do PIX (R$ 10,00). Fale com o Bureau."
- `openClientOrderAction`: com `result.pixPriceCents` definido, devolve `{ error: null, id, paymentRequired: true }`. O resto não muda.

**Steps:**

- [ ] Escrever `src/lib/orders/order-pix.integration.test.ts` (modelo: `src/lib/orders/coupon.integration.test.ts`). Casos e asserções:
  - `balance that covers the price reserves at once`: sem `pixPriceCents`; liquidação `reserved`; sem cotação; estado `awaiting_authorization`.
  - `low balance opens the order awaiting payment`: `pixPriceCents` = total - desconto; estado `awaiting_payment`; cotação com `price` e `coupon_code`; sem liquidação; nenhum lançamento novo na carteira; vaga de cupom apagada.
  - `zero price with a 100% coupon skips the PIX`: saldo 0; reserva feita; sem cotação; estado diferente de `awaiting_payment`.
  - `price above the PIX limit is refused and leaves nothing`: `pix_amount_above_limit`; nenhum Dossiê, pedido, autorização ou cotação novo.
  - `price below the PIX minimum is refused`: cupom de valor fixo que deixa R$ 5,00; `pix_amount_below_minimum`.
  - `exhausted coupon at opening is refused before the PIX`: `coupon_exhausted`; nada gravado.
  - `getOrderPayment returns null for another client's order`.
  - `getOrderPayment reports a pending charge past expires_at as expired without payload`.
- [ ] Em `src/actions/orders-client.test.ts`: `returns paymentRequired when placeOrder needs a PIX` e `keeps the plain result when the balance covers the price`.
- [ ] Rodar os dois arquivos. Ver falhar.
- [ ] Implementar as assinaturas acima.
- [ ] Rodar os dois arquivos e `src/lib/orders/queries.integration.test.ts`, `src/lib/orders/coupon*.integration.test.ts`, `src/actions/portal.integration.test.ts`. Ver passar. `npm run type-check`.
- [ ] Commit: `feat(orders): pedido online sem saldo fica aguardando o PIX com preço guardado`.

---

## Tarefa 4: Criação do PIX do pedido e resultados do webhook

**Files:**
- Modificar: `src/lib/wallet/pix-charges.ts` (`ChargeScope`, `reserveCharge`, `AsaasPaymentResult`)
- Modificar: `src/lib/payments/checkout.ts` (revalidação e trava de método para pedido)
- Modificar: `src/lib/validators/order.ts` (`orderPixSchema`)
- Criar: `src/actions/order-payment.ts`
- Modificar: `src/app/api/webhooks/asaas/route.ts`
- Modificar: `docs/architecture.md` (seção nova "Pagamento por pedido", depois de "Links de pagamento")
- Testes: `src/lib/payments/checkout.integration.test.ts`, `src/actions/order-payment.test.ts` (novo), `src/app/api/webhooks/asaas/route.test.ts`

**Depends-on:** T1, T2, T3.
**Agent:** `backend-specialist`. **Model:** `sonnet`.

**Interfaces:**

```ts
// src/lib/wallet/pix-charges.ts
export type ChargeScope =
	| { kind: "client"; clientProfileId: string; orderId?: string }
	| { kind: "bureau"; bureauId: string };
// reserveCharge grava order_id = scope.orderId ?? null (coluna nova no insert).
export type AsaasPaymentResult = /* atuais */ | "order_paid" | "order_reserve_failed" | "order_not_payable";

// src/lib/validators/order.ts
export const orderPixSchema = z.object({
	dossierId: z.string().uuid(),
	idempotencyKey: z.string().uuid(),
	payerKind: z.enum(["owner", "other"]).default("owner"),
	payer: payerFieldsSchema.optional(),
	declaration: z.literal(true).optional(),
});

// src/actions/order-payment.ts ("use server")
export async function createOrderPixAction(values: unknown): Promise<CheckoutActionResult>;
```

Fluxo de `createOrderPixAction`:
1. `orderPixSchema.safeParse`. Depois `requireClient` (mesma regra de `orders-client.ts`).
2. `getOrderPayment` em `withUserTransaction`. `null`: "Pedido não encontrado.". Estado diferente de `awaiting_payment`: "Este pedido não aguarda pagamento.".
3. Cobrança `pending` no prazo com `pixPayload`: `{ error: null, id, method: "PIX", reused: true }`. `pending` no prazo sem `pixPayload`: "O PIX está sendo gerado. Aguarde um instante.". `expired`: "O PIX venceu. O pedido será cancelado.". `paid`: "Pagamento já recebido.".
4. Senão: monta `CheckoutInput` no servidor (`amount = fromCents(priceCents)`, `method: "PIX"`, `payerKind`, `payer`, `declaration`, `idempotencyKey`), valida com `checkoutSchema`, e chama `runCheckout(session, { kind: "client", clientProfileId: session.userId, orderId: dossierId }, input, { remoteIp: ip ?? "", description: "Pedido de pesquisa" })`.
5. O valor do navegador nunca entra: o schema nem o aceita.

`runCheckout`: com `scope.orderId`, método diferente de PIX devolve "Este pedido só aceita PIX." e a revalidação é `/portal/pesquisas/<orderId>/pagar` e `/portal/pesquisas/<orderId>`. Nada mais muda.

Webhook (`route.ts`): `order_paid`, `order_reserve_failed` e `order_not_payable` seguem o caminho de `credited` (pedido da nota, `revalidateClientCredits`) e revalidam `/portal/pesquisas`. `order_reserve_failed` e `order_not_payable` também gravam `console.error` só com evento e `asaasPaymentId`.

`docs/architecture.md`: até 12 linhas. Fluxo, tabela `order_pix_quotes`, ramo `apply_order_pix_charge`, contexto montado no webhook, motivo `payment_not_reserved`.

**Steps:**

- [ ] Testes que falham:
  - `checkout.integration.test.ts`: `order charge stores order_id and the quote amount` (driver `fake`; linha com `order_id`, `amount = price`, `total_charged = price + taxa`); `order charge with a tampered amount fails closed` (chamada direta de `reserveCharge` com outro `amount`: erro, nenhuma linha).
  - `order-payment.test.ts` (mocks no padrão de `src/actions/orders-client.test.ts`): `createOrderPixAction ignores the browser amount` (`runCheckout` recebe `amount` da cotação); `returns not found for another client's order`; `returns reused for a live charge without calling runCheckout`; `refuses an order that is not awaiting payment`; `refuses an expired charge`.
  - `route.test.ts`: `order_paid requests the invoice`; `order_reserve_failed requests the invoice and logs only ids`.
- [ ] Rodar os três arquivos. Ver falhar.
- [ ] Implementar.
- [ ] Rodar os três arquivos, `src/lib/wallet/*.test.ts` e `src/lib/payments/*.test.ts`. Ver passar. `npm run type-check`, `npm run lint`.
- [ ] Commit: `feat(payments): PIX do pedido pelo checkout e resultados novos do webhook`.

---

## Tarefa 5: Vencimento e cancelamento do pedido sem pagamento

**Files:**
- Modificar: `src/lib/orders/tick-queries.ts` (`cancelStalledOrders`)
- Modificar: `src/lib/orders/queries.ts` (só `cancelOrder`)
- Modificar: `src/lib/orders/types.ts` (`OrderStateReason`, `ORDER_PIX_GRACE_MINUTES`)
- Modificar: `src/lib/ui/status.ts`, `src/lib/orders/labels.ts`
- Teste: `src/lib/orders/tick.integration.test.ts`

**Depends-on:** T1, T2, T3 (mesmo arquivo `queries.ts`).
**Agent:** `backend-specialist`. **Model:** `sonnet`.

**Interfaces:**
- `OrderStateReason` ganha `"payment_not_reserved"`. `export const ORDER_PIX_GRACE_MINUTES = 15;`
- `status.ts` (`orderReason`): `payment_not_reserved: ["neutral", CANCELLED, "Pagamento recebido como saldo"]`. `labels.ts`: a mesma chave na lista de motivos.
- `cancelOrder`: lê `state, mode` com `for update`. Para `mode = 'online'` e `state = 'awaiting_payment'`, `release_order` com `not_found` é aceito (não há liquidação). Qualquer outra falha lança, como hoje.

Consulta de candidatos de `cancelStalledOrders` (forma exata; `$2 = PIX_CHARGE_TTL_MINUTES + ORDER_PIX_GRACE_MINUTES`, `$3 = ORDER_PIX_GRACE_MINUTES`):

```sql
select o.dossier_id,
       case when o.state = 'awaiting_payment' and o.mode = 'online'
                 and exists (select 1 from pix_charges c where c.order_id = o.dossier_id and c.status = 'paid')
              then 'payment_not_reserved'
            when o.state = 'awaiting_payment' then 'payment_timeout'
            when exists (select 1 from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
                          where c.dossier_id = o.dossier_id and s.status = 'not_authorized') then 'scr_refused'
            else 'scr_expired' end as reason
  from dossier_orders o
 where o.bureau_id = app_bureau_id()
   and ((o.state = 'awaiting_payment' and o.mode = 'counter'
         and o.created_at < now() - make_interval(days => $1))
     -- Online: PIX pago e reserva recusada (o valor já é saldo), ou nenhum PIX vivo depois da validade e da folga.
     or (o.state = 'awaiting_payment' and o.mode = 'online'
         and (exists (select 1 from pix_charges c where c.order_id = o.dossier_id and c.status = 'paid')
              or (o.created_at < now() - make_interval(mins => $2)
                  and not exists (select 1 from pix_charges c
                                   where c.order_id = o.dossier_id and c.status = 'pending'
                                     and c.expires_at > now() - make_interval(mins => $3)))))
     or (o.state = 'awaiting_authorization'
         and exists (select 1 from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
                      where c.dossier_id = o.dossier_id and s.status in ('not_authorized', 'expired'))))
 order by o.created_at
 for update of o skip locked
```

`skip locked`: o tick nunca espera o webhook. Quem trava o pedido primeiro decide. Webhook depois do cancelamento: `order_not_payable` (saldo). Tick depois do pagamento: o pedido não está mais em `awaiting_payment`.

**Steps:**

- [ ] Em `tick.integration.test.ts`, casos que falham:
  - `cancels an online order whose PIX expired`: cobrança `pending` com `expires_at` = agora - 16 min; pedido `cancelled`, `state_reason = 'payment_timeout'`; nenhum lançamento na carteira.
  - `keeps an online order with a live PIX`: `expires_at` no futuro; continua `awaiting_payment`.
  - `keeps an online order inside the grace window`: `expires_at` = agora - 5 min; continua `awaiting_payment`.
  - `cancels an online order without any charge after 45 minutes`: sem cobrança, `created_at` = agora - 46 min; `payment_timeout`.
  - `cancels a paid order whose reservation failed`: cobrança `paid`, sem liquidação; `payment_not_reserved`; saldo disponível igual ao de antes do tick.
  - `tick cancel and webhook payment never leave a reservation on a cancelled order`: conexão A roda `cancelStalledOrders` sem commit; conexão B chama o webhook e espera; A faz commit; B devolve `order_not_payable`; sem liquidação `reserved` no pedido; saldo sobe `price`. Ordem inversa: B termina antes; o tick não cancela; liquidação `reserved`.
  - `staff cancel of an online order awaiting payment works`: `cancelOrder(..., "cancelled_by_staff")` devolve `ok`.
- [ ] Rodar o arquivo. Ver falhar.
- [ ] Implementar.
- [ ] Rodar `src/lib/orders/tick.integration.test.ts` e `src/lib/orders/queries.integration.test.ts`. Ver passar. `npm run type-check`.
- [ ] Commit: `feat(orders): tick cancela pedido online com PIX vencido ou reserva recusada`.

---

## Tarefa 6: Tela de pagamento do pedido

**Files:**
- Criar: `src/app/(portal)/portal/pesquisas/[id]/pagar/page.tsx`
- Criar: `src/components/orders/order-pix-panel.tsx`
- Criar: `src/components/orders/order-pix-view.ts` e `src/components/orders/order-pix-view.test.ts`
- Modificar: `src/components/payments/CheckoutForm.tsx` (prop `fixed`)
- Modificar: `src/components/orders/client-order-form.tsx` (só o redirecionamento)
- Modificar: `src/app/(portal)/portal/pesquisas/[id]/page.tsx` (aviso de pagamento)
- Criar: `e2e/portal-order-pix.spec.ts`

**Depends-on:** T3, T4, T5.
**Agent:** `frontend-specialist`. **Model:** `sonnet`. Antes: `/vercel:nextjs` e `/ui-ux-pro-max`.

**Interfaces:**

```ts
// src/components/orders/order-pix-view.ts (sem React; testável)
export type OrderPixView = "show_qr" | "generate" | "in_progress" | "expired" | "paid_not_reserved" | "leave";
export function orderPixView(payment: OrderPayment, now: Date): OrderPixView;
// leave: estado diferente de awaiting_payment. paid_not_reserved: cobrança paid e estado awaiting_payment.
export function afterPoll(outcome: PollOutcome, expiresAt: Date, now: Date): "go_to_order" | "expired" | "poll_again" | "failed";

// CheckoutForm: nova prop opcional. Com ela, sem passo de valor, método só PIX, sem cartão.
fixed?: { amountCents: number };
```

Comportamento da página (servidor):
- Sessão de cliente; `getOrderPayment`. `null`: `notFound()`. `leave`: `redirect` para `/portal/pesquisas/<id>`.
- `show_qr`: QR feito no servidor com `QRCode.toDataURL(pixPayload, { margin: 1, width: 208 })` (padrão de `src/lib/payment-links/pix.ts`), código copia e cola, valor (preço, taxa, total), validade.
- `generate`: `OrderPixPanel` com `idempotencyKey = randomUUID()` gerado no servidor. Na montagem chama `createOrderPixAction({ dossierId, idempotencyKey })` uma vez. `reused`: `router.refresh()`. Erro "Preencha os dados de pagamento que faltam.": mostra `CheckoutForm` com `scope="client"`, `fixed={{ amountCents: priceCents }}` e `action={(input) => createOrderPixAction({ dossierId, ...input, idempotencyKey: input.idempotencyKey })}`. Outro erro: mensagem e botão "Tentar de novo".
- `in_progress`: "Gerando o PIX..." e `router.refresh()` a cada 5 s.
- `expired`: "O PIX venceu. O pedido será cancelado. Faça um novo pedido." e link para `/portal/pesquisas/nova`.
- `paid_not_reserved`: "Recebemos o pagamento, mas não foi possível iniciar o pedido. O valor está no seu saldo." e links para `/portal/credits` e `/portal/pesquisas/nova`.
- Polling: `useChargePolling` com o id da cobrança. `afterPoll`: `paid` vai para `/portal/pesquisas/<id>`; `timeout` antes de `expiresAt` chama `start(id)` de novo.
- `client-order-form.tsx`: com `result.paymentRequired`, `router.push(\`/portal/pesquisas/${result.id}/pagar\`)`.
- Página do pedido: em `awaiting_payment`, aviso "Aguardando o pagamento do PIX" com link "Pagar com PIX" (ou o texto de `paid_not_reserved`).
- Alvos de toque com 44 px no celular (`docs/design.md:53`). Texto em pt-BR.

**Steps:**

- [ ] Escrever `order-pix-view.test.ts`: um caso por saída de `orderPixView` (6) e de `afterPoll` (4), com as datas na borda (`expiresAt` igual a `now`).
- [ ] Escrever `e2e/portal-order-pix.spec.ts` (driver `fake`): cliente sem saldo (use um cliente de teste com carteira zerada; se não existir, crie em `e2e/global-setup.ts` sem mudar o cliente atual) compra um Dossiê; a página `/pagar` mostra o QR; o teste lê `asaas_payment_id` por `dbQuery` e envia `PAYMENT_RECEIVED` para `/api/webhooks/asaas` com o token de `ASAAS_WEBHOOK_TOKEN`; a página vai para `/portal/pesquisas/<id>` com "Aguardando autorização".
- [ ] Rodar `npm run test -- src/components/orders/order-pix-view.test.ts` e o E2E novo. Ver falhar.
- [ ] Implementar.
- [ ] Rodar o teste unitário, o E2E novo e `e2e/portal-order.spec.ts` (sem mudança: o cliente atual tem saldo). Ver passar. `npm run type-check`, `npm run lint`.
- [ ] Commit: `feat(portal): tela de pagamento do pedido com QR e confirmação automática`.

---

## Ondas

| Onda | Tarefas | Motivo |
|---|---|---|
| 1 | T1 | Esquema base. |
| 2 | T2, T3 | Arquivos disjuntos; ambos só dependem de T1. |
| 3 | T4, T5 | Arquivos disjuntos; T5 usa `queries.ts` depois de T3. |
| 4 | T6 | Consome T3, T4 e T5. |

## Post-deploy follow-up

- (post-deploy) Webhook real do Asaas para um PIX de pedido: `PAYMENT_RECEIVED` com `payment.value` igual a `total_charged`, resultado `order_paid` em `asaas_webhook_events`, nota fiscal pedida.
- (post-deploy) Pagamento de um QR depois do vencimento de 30 min no Asaas real: resultado `order_not_payable` e saldo creditado.
- (post-deploy) Consulta em produção, logo depois da migration: `select count(*) from dossier_orders o where o.mode = 'online' and o.state in ('awaiting_authorization', 'ready') and not exists (select 1 from order_settlements s where s.order_ref = o.dossier_id and s.status in ('reserved', 'captured'))` deve dar 0.

## Fora do escopo

- Cliente cancelar pedido que espera o PIX (`cancel_client_order` só aceita `awaiting_authorization` e `ready`). O PIX vence em 30 min + 15 min.
- Cancelar no Asaas o PIX vencido (melhor esforço, padrão `cancelAsaasPayments`). Pagamento tardio vira saldo.
- Cartão no pedido.

Revisão final de dinheiro: 1 vez, por opus, ao terminar a issue.
