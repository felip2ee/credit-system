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
alter table order_pix_quotes owner to schema_owner;
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

-- Estado do pedido a partir do dinheiro e do consentimento (corpo da 022). Muda só o bloco do pagamento:
-- online, pago = liquidação reserved ou captured. Dono e grants da 022 ficam (create or replace).
create or replace function refresh_order_state(p_dossier_id uuid)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_o public.dossier_orders;
  v_price numeric;
  v_paid numeric;
  v_paid_ok boolean := true;
  v_auth_ok boolean;
  v_next text;
begin
  select * into v_o from public.dossier_orders where dossier_id = p_dossier_id for update;
  if not found then return null; end if;
  if v_o.state not in ('awaiting_payment', 'awaiting_authorization', 'ready') then return v_o.state; end if;
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
  select bool_and(coalesce(s.status = 'authorized' and s.expires_at > now(), false)) into v_auth_ok
    from public.consultations c
    left join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.dossier_id = p_dossier_id;
  v_next := case when not v_paid_ok then 'awaiting_payment'
                 when coalesce(v_auth_ok, false) then 'ready'
                 else 'awaiting_authorization' end;
  if v_next <> v_o.state then
    update public.dossier_orders set state = v_next, updated_at = now() where dossier_id = p_dossier_id;
  end if;
  return v_next;
end
$$;
