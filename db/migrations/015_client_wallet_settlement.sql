-- M3b: carteira do cliente, liquidação por pedido, valor a repassar e pagamento de balcão.
-- A 003–014 já foram aplicadas e não mudam.
-- 1) client_wallets / client_ledger_entries: mesmo desenho do M3a (012), uma carteira por cliente.
--    O núcleo client_wallet_post_entry espelha wallet_post_entry; ninguém além das funções SQL escreve nas tabelas.
-- 2) pix_charges ganha client_profile_id: com ele, apply_asaas_payment credita (e estorna) a carteira do cliente.
-- 3) order_settlements + reserve_order / capture_order / release_order: reserva, captura e liberação idempotentes
--    por order_ref. Ordem de travas fixa: liquidação, carteira do cliente, carteira do Bureau.
-- 4) bureau_payable_entries (só INSERT) guarda o valor a repassar; counter_payments guarda o pagamento de balcão.
-- 5) Chaves de idempotência com prefixo "order:" e "pix" são reservadas às funções internas.

create function append_only_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = 'check_violation';
end
$$;

-- Carteira do cliente.
create table client_wallets (
  client_profile_id uuid primary key,
  bureau_id uuid not null references bureaus(id),
  available numeric(15,2) not null default 0 check (available >= 0),
  reserved numeric(15,2) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  unique (bureau_id, client_profile_id),
  foreign key (bureau_id, client_profile_id) references profiles(bureau_id, id)
);

create trigger client_wallets_updated_at before update on client_wallets
  for each row execute function set_updated_at();

create table client_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  bureau_id uuid not null references bureaus(id),
  client_profile_id uuid not null,
  kind text not null check (kind in ('topup', 'reserve', 'capture', 'release', 'reversal')),
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  available_after numeric(15,2) not null check (available_after >= 0),
  reserved_after numeric(15,2) not null check (reserved_after >= 0),
  idempotency_key text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
  reference text,
  reason text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (client_profile_id, idempotency_key),
  foreign key (bureau_id, client_profile_id) references client_wallets(bureau_id, client_profile_id)
);

create index client_ledger_entries_client_seq_idx on client_ledger_entries(client_profile_id, seq desc);
create index client_ledger_entries_bureau_idx on client_ledger_entries(bureau_id);

create trigger client_ledger_entries_immutable before update or delete on client_ledger_entries
  for each row execute function append_only_guard();
create trigger client_ledger_entries_no_truncate before truncate on client_ledger_entries
  for each statement execute function append_only_guard();

-- Cobrança PIX do cliente: client_profile_id preenchido (e igual ao autor) marca a cobrança como do cliente.
alter table pix_charges add column client_profile_id uuid;
alter table pix_charges add constraint pix_charges_client_wallet_fk
  foreign key (bureau_id, client_profile_id) references client_wallets(bureau_id, client_profile_id);
alter table pix_charges add constraint pix_charges_client_requester_check
  check (client_profile_id is null or requested_by = client_profile_id);
create index pix_charges_client_created_idx on pix_charges(client_profile_id, created_at desc)
  where client_profile_id is not null;

-- Liquidação por pedido. order_ref é o id do Dossiê (o M6 liga o pedido).
create table order_settlements (
  id uuid primary key default gen_random_uuid(),
  order_ref uuid not null unique,
  bureau_id uuid not null references bureaus(id),
  mode text not null check (mode in ('online', 'counter')),
  client_profile_id uuid,
  price numeric(15,2) not null check (price > 0 and price <= 99999999.99),
  cost numeric(15,2) not null check (cost >= 0 and cost <= 99999999.99),
  quote jsonb not null default '{}'::jsonb,
  status text not null default 'reserved' check (status in ('reserved', 'captured', 'released')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint order_settlements_price_cost check (price >= cost),
  constraint order_settlements_mode_client check ((mode = 'online') = (client_profile_id is not null)),
  constraint order_settlements_closed check ((status = 'reserved') = (closed_at is null)),
  -- FK para profiles, não para client_wallets: a FK trava a carteira com KEY SHARE e duas reservas
  -- concorrentes entrariam em deadlock ao pedir FOR UPDATE nela.
  foreign key (bureau_id, client_profile_id) references profiles(bureau_id, id)
);

create index order_settlements_bureau_created_idx on order_settlements(bureau_id, created_at desc);
create index order_settlements_client_idx on order_settlements(client_profile_id) where client_profile_id is not null;

-- Só a transição reserved -> captured | released é permitida; nenhum outro campo muda e nada se apaga.
create function order_settlements_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'reserved'
     and new.status in ('captured', 'released')
     and (to_jsonb(new) - 'status' - 'closed_at') = (to_jsonb(old) - 'status' - 'closed_at') then
    return new;
  end if;
  raise exception 'order_settlements allows only the close transition' using errcode = 'check_violation';
end
$$;

create trigger order_settlements_guard before update or delete on order_settlements
  for each row execute function order_settlements_guard();
create trigger order_settlements_no_truncate before truncate on order_settlements
  for each statement execute function order_settlements_guard();

-- Valor a repassar ao Bureau: acréscimo (+), estorno (−) e repasse pago (−). A coluna payout_id vem na 016.
create table bureau_payable_entries (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  kind text not null check (kind in ('accrual', 'reversal', 'payout')),
  amount numeric(15,2) not null,
  order_ref uuid references order_settlements(order_ref),
  created_at timestamptz not null default now(),
  constraint bureau_payable_entries_amount check (
    abs(amount) <= 99999999.99
    and ((kind = 'accrual' and amount > 0) or (kind in ('reversal', 'payout') and amount < 0))
  )
);

create index bureau_payable_entries_bureau_created_idx on bureau_payable_entries(bureau_id, created_at desc, id);
-- Um pedido gera no máximo um acréscimo.
create unique index bureau_payable_entries_accrual_order_idx on bureau_payable_entries(order_ref) where kind = 'accrual';

create trigger bureau_payable_entries_immutable before update or delete on bureau_payable_entries
  for each row execute function append_only_guard();
create trigger bureau_payable_entries_no_truncate before truncate on bureau_payable_entries
  for each statement execute function append_only_guard();

-- Pagamento recebido no balcão. Não mexe em carteira. A anulação passa por void_counter_payment.
create table counter_payments (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  dossier_id uuid not null,
  method text not null check (method in ('cash', 'pix', 'card_machine', 'transfer', 'other')),
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  received_at timestamptz not null default now(),
  registered_by uuid not null,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text check (void_reason is null or (btrim(void_reason) <> '' and length(void_reason) <= 500)),
  constraint counter_payments_void_complete check (
    (voided_at is null) = (voided_by is null) and (voided_at is null) = (void_reason is null)
  ),
  foreign key (bureau_id, dossier_id) references dossiers(bureau_id, id),
  foreign key (bureau_id, registered_by) references profiles(bureau_id, id),
  foreign key (bureau_id, voided_by) references profiles(bureau_id, id)
);

create index counter_payments_dossier_idx on counter_payments(bureau_id, dossier_id, received_at desc);

-- Só a anulação (voided_*, uma vez, com motivo) pode mudar a linha; nada se apaga.
create function counter_payments_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and old.voided_at is null
     and new.voided_at is not null
     and new.voided_by is not null
     and btrim(coalesce(new.void_reason, '')) <> ''
     and (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason')
         = (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    return new;
  end if;
  raise exception 'counter_payments allows only a single void' using errcode = 'check_violation';
end
$$;

create trigger counter_payments_guard before update or delete on counter_payments
  for each row execute function counter_payments_guard();
create trigger counter_payments_no_truncate before truncate on counter_payments
  for each statement execute function counter_payments_guard();

alter table client_wallets enable row level security;
alter table client_wallets force row level security;
alter table client_ledger_entries enable row level security;
alter table client_ledger_entries force row level security;
alter table order_settlements enable row level security;
alter table order_settlements force row level security;
alter table bureau_payable_entries enable row level security;
alter table bureau_payable_entries force row level security;
alter table counter_payments enable row level security;
alter table counter_payments force row level security;

-- Tenant: a equipe do Bureau lê as carteiras dos clientes dele; o cliente lê só a própria.
create policy client_wallets_select_staff on client_wallets for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy client_wallets_select_own on client_wallets for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
);
create policy client_ledger_entries_select_staff on client_ledger_entries for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy client_ledger_entries_select_own on client_ledger_entries for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
);
create policy order_settlements_select_staff on order_settlements for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy order_settlements_select_own on order_settlements for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
);
-- Exceção estreita: o superadmin sem suporte lê o valor a repassar de qualquer Bureau (só SELECT, só esta tabela e payouts na 016).
create policy bureau_payable_entries_select on bureau_payable_entries for select using (
  (bureau_id = app_bureau_id() and app_user_role() in ('bureau_admin', 'operator') and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy counter_payments_select on counter_payments for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy counter_payments_insert on counter_payments for insert with check (
  bureau_id = app_bureau_id() and (select app_is_staff())
  and registered_by = app_user_id() and voided_at is null
);

-- Cobrança do cliente: o cliente lê e cria só as próprias. A cobrança do Bureau não pode citar cliente.
create policy pix_charges_client_select on pix_charges for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
);
create policy pix_charges_client_insert on pix_charges for insert with check (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
  and requested_by = app_user_id() and status = 'pending'
);
drop policy pix_charges_admin_insert on pix_charges;
create policy pix_charges_admin_insert on pix_charges for insert with check (
  bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff())
  and requested_by = app_user_id() and status = 'pending' and client_profile_id is null
);

-- Cada cliente nasce com a carteira zerada.
create function client_wallets_create_for_client()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.client_wallets (client_profile_id, bureau_id) values (new.id, new.bureau_id);
  return new;
end
$$;

create trigger profiles_create_client_wallet after insert on profiles
  for each row when (new.role = 'client') execute function client_wallets_create_for_client();

-- Único código que escreve na carteira do cliente: trava a linha, valida, insere o lançamento, atualiza o saldo.
-- Não autoriza ninguém: só as funções de liquidação, client_wallet_apply e apply_asaas_payment a chamam.
create function client_wallet_post_entry(
  p_client_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text,
  p_created_by uuid
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau_id uuid;
  v_available numeric;
  v_reserved numeric;
  v_available_after numeric;
  v_reserved_after numeric;
  v_entry public.client_ledger_entries;
  v_id uuid;
begin
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'reversal') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or abs(p_amount) > 99999999.99 or p_amount <= 0 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, available, reserved into v_bureau_id, v_available, v_reserved
    from public.client_wallets where client_profile_id = p_client_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.client_ledger_entries
   where client_profile_id = p_client_profile_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.available_after, v_entry.reserved_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_available_after := v_available;
  v_reserved_after := v_reserved;
  case p_kind
    when 'topup' then
      v_available_after := v_available + p_amount;
    when 'reserve' then
      v_available_after := v_available - p_amount;
      v_reserved_after := v_reserved + p_amount;
    when 'capture' then
      v_reserved_after := v_reserved - p_amount;
    when 'release' then
      v_reserved_after := v_reserved - p_amount;
      v_available_after := v_available + p_amount;
    when 'reversal' then
      v_available_after := v_available - p_amount;
  end case;

  if v_available_after < 0 then
    return query select false, 'insufficient_balance'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if v_reserved_after < 0 then
    return query select false, 'reservation_exceeded'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.client_ledger_entries
    (bureau_id, client_profile_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by)
  values
    (v_bureau_id, p_client_profile_id, p_kind, p_amount, v_available_after, v_reserved_after, p_idempotency_key,
     p_reference, p_reason, p_created_by)
  returning id into v_id;
  update public.client_wallets set available = v_available_after, reserved = v_reserved_after
   where client_profile_id = p_client_profile_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

-- Caminho da sessão do próprio cliente: reserve, capture, release. topup e reversal são do webhook.
-- Interna: app_runtime não a executa. As chaves "order:" e "pix" pertencem às funções internas.
create function client_wallet_apply(
  p_client_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present()
     or p_kind not in ('reserve', 'capture', 'release') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key like 'pix%' or p_idempotency_key like 'order:%' then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if public.app_user_role() <> 'client' or public.app_user_id() is distinct from p_client_profile_id then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  return query select * from public.client_wallet_post_entry(
    p_client_profile_id, p_kind, p_amount, p_idempotency_key, p_reference, p_reason, public.app_user_id());
end
$$;

-- As chaves "order:" (liquidação) e "pix" (webhook) não podem colidir com a sessão.
create or replace function wallet_apply(
  p_bureau_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present()
     or p_kind not in ('reserve', 'capture', 'release', 'adjustment') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key like 'pix%' or p_idempotency_key like 'order:%' then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_kind = 'adjustment' then
    if public.app_user_role() <> 'superadmin' then
      return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
      return;
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      return query select false, 'reason_required'::text, null::uuid, null::numeric, null::numeric, false;
      return;
    end if;
  elsif public.app_bureau_id() is distinct from p_bureau_id then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  return query select * from public.wallet_post_entry(
    p_bureau_id, p_kind, p_amount, p_idempotency_key, p_reference, p_reason, public.app_user_id());
end
$$;

-- Reserva do pedido. Online: o próprio cliente reserva o preço na carteira dele. Balcão: a equipe reserva o custo
-- na carteira do Bureau. A liquidação grava preço e custo: capture_order e release_order nunca os recebem de novo.
-- Sem saldo, a linha da liquidação não fica (o bloco com EXCEPTION desfaz o insert).
create function reserve_order(
  p_order_ref uuid,
  p_mode text,
  p_client_profile_id uuid,
  p_price numeric,
  p_cost numeric,
  p_quote jsonb
)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_id uuid;
  v_existing public.order_settlements;
  v_post record;
  v_fail text;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or p_mode is null or p_mode not in ('online', 'counter') then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if p_mode = 'online' then
    if public.app_user_role() <> 'client' or p_client_profile_id is distinct from v_user then
      return query select false, 'not_allowed'::text, null::text;
      return;
    end if;
  elsif p_client_profile_id is not null or not public.app_is_staff() then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if p_price is null or p_cost is null or p_price <> round(p_price, 2) or p_cost <> round(p_cost, 2)
     or p_price <= 0 or p_cost < 0 or p_price > 99999999.99 or p_cost > 99999999.99
     or (p_mode = 'counter' and p_cost = 0) then
    return query select false, 'invalid_amount'::text, null::text;
    return;
  end if;
  if p_price < p_cost then
    return query select false, 'price_below_cost'::text, null::text;
    return;
  end if;

  begin
    -- 1º: linha da liquidação. A unicidade de order_ref serializa duas reservas do mesmo pedido.
    insert into public.order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, quote)
    values (p_order_ref, v_bureau, p_mode, p_client_profile_id, p_price, p_cost, coalesce(p_quote, '{}'::jsonb))
    on conflict (order_ref) do nothing
    returning id into v_id;

    if v_id is null then
      select * into v_existing from public.order_settlements where order_ref = p_order_ref for update;
      if v_existing.bureau_id is distinct from v_bureau then
        return query select false, 'not_allowed'::text, null::text;
      elsif v_existing.mode = p_mode
         and v_existing.client_profile_id is not distinct from p_client_profile_id
         and v_existing.price = p_price and v_existing.cost = p_cost then
        return query select true, null::text, v_existing.status;
      else
        return query select false, 'already_exists'::text, null::text;
      end if;
      return;
    end if;

    -- 2º: carteira do cliente (online) ou 3º: carteira do Bureau (balcão).
    if p_mode = 'online' then
      select * into v_post from public.client_wallet_post_entry(
        p_client_profile_id, 'reserve', p_price, 'order:reserve:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    else
      select * into v_post from public.wallet_post_entry(
        v_bureau, 'reserve', p_cost, 'order:reserve:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    end if;
    if not v_post.ok then
      v_fail := v_post.reason;
      raise exception 'reserve_order rolled back' using errcode = 'RS001';
    end if;
  exception when sqlstate 'RS001' then
    return query select false, v_fail, null::text;
    return;
  end;

  return query select true, null::text, 'reserved'::text;
end
$$;

-- Captura o valor gravado. Online: o preço sai do cliente e a diferença para o custo vira acréscimo do Bureau.
-- Balcão: o custo sai do Bureau. Qualquer identidade do Bureau captura; o cliente só o próprio pedido.
create function capture_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'released' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  if v_s.mode = 'online' then
    select * into v_post from public.client_wallet_post_entry(
      v_s.client_profile_id, 'capture', v_s.price, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      raise exception 'capture_order failed: %', v_post.reason;
    end if;
    if v_s.price > v_s.cost then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
      values (v_s.bureau_id, 'accrual', v_s.price - v_s.cost, v_s.order_ref);
    end if;
  else
    select * into v_post from public.wallet_post_entry(
      v_s.bureau_id, 'capture', v_s.cost, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      raise exception 'capture_order failed: %', v_post.reason;
    end if;
  end if;

  update public.order_settlements set status = 'captured', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'captured'::text;
end
$$;

-- Libera a reserva gravada. Sem acréscimo. Mesmas regras de identidade da captura.
create function release_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'released' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  if v_s.mode = 'online' then
    select * into v_post from public.client_wallet_post_entry(
      v_s.client_profile_id, 'release', v_s.price, 'order:release:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
  else
    select * into v_post from public.wallet_post_entry(
      v_s.bureau_id, 'release', v_s.cost, 'order:release:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
  end if;
  if not v_post.ok then
    raise exception 'release_order failed: %', v_post.reason;
  end if;

  update public.order_settlements set status = 'released', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'released'::text;
end
$$;

-- Anulação do pagamento de balcão: com motivo, uma vez, sem mexer no valor.
create function void_counter_payment(p_id uuid, p_reason text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_payment public.counter_payments;
begin
  if not public.app_context_present() or v_bureau is null or not public.app_is_staff() then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    return query select false, 'reason_required'::text;
    return;
  end if;

  select * into v_payment from public.counter_payments
   where id = p_id and bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if v_payment.voided_at is not null then
    return query select false, 'already_voided'::text;
    return;
  end if;

  update public.counter_payments
     set voided_at = now(), voided_by = public.app_user_id(), void_reason = btrim(p_reason)
   where id = p_id;
  return query select true, null::text;
end
$$;

-- Webhook sem sessão: o valor vem de pix_charges.amount, nunca do payload. Cobrança com client_profile_id
-- credita (e estorna) a carteira do cliente; a do Bureau segue como na 014. Os nomes de evento espelham
-- as constantes de src/lib/asaas/client.ts (um teste confere).
create or replace function apply_asaas_payment(
  p_event_id text,
  p_event_type text,
  p_asaas_payment_id text,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_post record;
  v_event_row uuid;
  v_result text;
  v_available numeric;
  v_reversed numeric;
  v_shortfall numeric;
  v_audit_table text;
  v_audit_record uuid;
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

  -- Cobrança desconhecida: guarda só o registro do evento, sem o corpo (evita inchar a tabela).
  insert into public.asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
  values (v_charge.bureau_id, p_event_id, p_event_type, p_asaas_payment_id,
    case when v_charge.id is null then null else coalesce(p_payload, '{}'::jsonb) end, 'received')
  on conflict (event_id) do nothing
  returning id into v_event_row;
  if v_event_row is null then
    return 'duplicate';
  end if;

  if v_charge.id is null then
    v_result := 'unknown_charge';
  elsif p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status in ('paid', 'refunded') then
      v_result := 'duplicate';
    elsif v_charge.status = 'cancelled' then
      v_result := 'ignored';
    else
      update public.pix_charges set status = 'paid' where id = v_charge.id;
      if v_charge.client_profile_id is null then
        select * into v_post from public.wallet_post_entry(
          v_charge.bureau_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
          'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
        v_audit_table := 'ledger_entries';
      else
        select * into v_post from public.client_wallet_post_entry(
          v_charge.client_profile_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
          'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
        v_audit_table := 'client_ledger_entries';
      end if;
      if not v_post.ok then
        raise exception 'wallet topup failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', v_audit_table, v_post.entry_id,
        jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id, 'amount', v_charge.amount::text));
      v_result := 'credited';
    end if;
  elsif p_event_type = 'PAYMENT_REFUNDED' then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status = 'refunded' then
      v_result := 'duplicate';
    elsif v_charge.status <> 'paid' then
      v_result := 'ignored';
    else
      -- Trava a carteira antes de ler o saldo: o estorno tira só o que está disponível agora.
      if v_charge.client_profile_id is null then
        select available into strict v_available
          from public.wallets where bureau_id = v_charge.bureau_id for update;
      else
        select available into strict v_available
          from public.client_wallets where client_profile_id = v_charge.client_profile_id for update;
      end if;
      v_reversed := least(v_available, v_charge.amount);
      v_shortfall := v_charge.amount - v_reversed;
      update public.pix_charges set status = 'refunded', refund_shortfall = v_shortfall where id = v_charge.id;
      if v_reversed > 0 then
        if v_charge.client_profile_id is null then
          select * into v_post from public.wallet_post_entry(
            v_charge.bureau_id, 'reversal', v_reversed, 'pixrefund:' || v_charge.id::text,
            'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
          v_audit_table := 'ledger_entries';
        else
          select * into v_post from public.client_wallet_post_entry(
            v_charge.client_profile_id, 'reversal', v_reversed, 'pixrefund:' || v_charge.id::text,
            'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
          v_audit_table := 'client_ledger_entries';
        end if;
        if not v_post.ok then
          raise exception 'wallet reversal failed: %', v_post.reason;
        end if;
        v_audit_record := v_post.entry_id;
      else
        -- Sem saldo não há lançamento (valor > 0): a auditoria aponta para a cobrança.
        v_audit_table := 'pix_charges';
        v_audit_record := v_charge.id;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.reversal', v_audit_table, v_audit_record,
        jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id,
          'amount', v_reversed::text, 'shortfall', v_shortfall::text));
      v_result := 'refunded';
    end if;
  else
    v_result := 'ignored';
  end if;

  update public.asaas_webhook_events set result = v_result where id = v_event_row;
  return v_result;
end
$$;

alter table client_wallets owner to schema_owner;
alter table client_ledger_entries owner to schema_owner;
alter table order_settlements owner to schema_owner;
alter table bureau_payable_entries owner to schema_owner;
alter table counter_payments owner to schema_owner;
alter function append_only_guard() owner to schema_owner;
alter function order_settlements_guard() owner to schema_owner;
alter function counter_payments_guard() owner to schema_owner;
alter function client_wallets_create_for_client() owner to auth_profile_lookup;
alter function client_wallet_post_entry(uuid, text, numeric, text, text, text, uuid) owner to auth_profile_lookup;
alter function client_wallet_apply(uuid, text, numeric, text, text, text) owner to auth_profile_lookup;
alter function reserve_order(uuid, text, uuid, numeric, numeric, jsonb) owner to auth_profile_lookup;
alter function capture_order(uuid) owner to auth_profile_lookup;
alter function release_order(uuid) owner to auth_profile_lookup;
alter function void_counter_payment(uuid, text) owner to auth_profile_lookup;

revoke all on function append_only_guard() from public;
revoke all on function order_settlements_guard() from public;
revoke all on function counter_payments_guard() from public;
revoke all on function client_wallets_create_for_client() from public;
-- Internas: nenhuma role de aplicação executa (nem app_runtime, nem app_webhook).
revoke all on function client_wallet_post_entry(uuid, text, numeric, text, text, text, uuid) from public, app_runtime;
revoke all on function client_wallet_apply(uuid, text, numeric, text, text, text) from public, app_runtime;
revoke all on function reserve_order(uuid, text, uuid, numeric, numeric, jsonb) from public;
revoke all on function capture_order(uuid) from public;
revoke all on function release_order(uuid) from public;
revoke all on function void_counter_payment(uuid, text) from public;
grant execute on function reserve_order(uuid, text, uuid, numeric, numeric, jsonb) to app_runtime;
grant execute on function capture_order(uuid) to app_runtime;
grant execute on function release_order(uuid) to app_runtime;
grant execute on function void_counter_payment(uuid, text) to app_runtime;

revoke all on client_wallets, client_ledger_entries, order_settlements, bureau_payable_entries, counter_payments
  from public, app_runtime, auth_profile_lookup;
grant select on client_wallets, client_ledger_entries, order_settlements, bureau_payable_entries, counter_payments
  to app_runtime;
grant insert (bureau_id, dossier_id, method, amount, received_at, registered_by, note)
  on counter_payments to app_runtime;
grant insert (client_profile_id) on pix_charges to app_runtime;
grant select on client_wallets, client_ledger_entries, order_settlements, bureau_payable_entries, counter_payments
  to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select, insert (client_profile_id, bureau_id), update (available, reserved) on client_wallets to auth_profile_lookup;
grant select, insert on client_ledger_entries to auth_profile_lookup;
grant select, insert (order_ref, bureau_id, mode, client_profile_id, price, cost, quote),
  update (status, closed_at) on order_settlements to auth_profile_lookup;
grant select, insert on bureau_payable_entries to auth_profile_lookup;
grant select, update (voided_at, voided_by, void_reason) on counter_payments to auth_profile_lookup;

create policy client_wallets_gateway_select on client_wallets for select to auth_profile_lookup using (true);
create policy client_wallets_gateway_insert on client_wallets for insert to auth_profile_lookup with check (true);
create policy client_wallets_gateway_update on client_wallets for update to auth_profile_lookup
  using (true) with check (true);
create policy client_ledger_entries_gateway_select on client_ledger_entries for select to auth_profile_lookup
  using (true);
create policy client_ledger_entries_gateway_insert on client_ledger_entries for insert to auth_profile_lookup
  with check (true);
create policy order_settlements_gateway_select on order_settlements for select to auth_profile_lookup using (true);
create policy order_settlements_gateway_insert on order_settlements for insert to auth_profile_lookup
  with check (true);
create policy order_settlements_gateway_update on order_settlements for update to auth_profile_lookup
  using (true) with check (true);
create policy bureau_payable_entries_gateway_select on bureau_payable_entries for select to auth_profile_lookup
  using (true);
create policy bureau_payable_entries_gateway_insert on bureau_payable_entries for insert to auth_profile_lookup
  with check (true);
create policy counter_payments_gateway_select on counter_payments for select to auth_profile_lookup using (true);
create policy counter_payments_gateway_update on counter_payments for update to auth_profile_lookup
  using (true) with check (true);

-- Auditoria do webhook para o ledger do cliente: as mesmas condições da 012 e da 014 (só o dono das funções, só
-- a ação certa, só junto do lançamento do mesmo Bureau e autor criado na mesma transação), agora também sobre
-- client_ledger_entries. Nenhuma outra ação ou tabela é aberta.
drop policy audit_logs_topup_insert on audit_logs;
create policy audit_logs_topup_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'wallet.topup'
  and support_session_id is null
  and bureau_id is not null
  and (
    (
      table_name = 'ledger_entries'
      and exists (
        select 1 from ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'topup'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
    or (
      table_name = 'client_ledger_entries'
      and exists (
        select 1 from client_ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'topup'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
  )
);

drop policy audit_logs_reversal_insert on audit_logs;
create policy audit_logs_reversal_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'wallet.reversal'
  and support_session_id is null
  and bureau_id is not null
  and (
    (
      table_name = 'ledger_entries'
      and exists (
        select 1 from ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'reversal'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
    or (
      table_name = 'client_ledger_entries'
      and exists (
        select 1 from client_ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'reversal'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
    or (
      table_name = 'pix_charges'
      and exists (
        select 1 from pix_charges c
         where c.id = audit_logs.record_id
           and c.status = 'refunded'
           and c.bureau_id = audit_logs.bureau_id
           and c.requested_by = audit_logs.user_id
      )
    )
  )
);

-- Carteira dos clientes que já existem. O dono tem RLS forçado e não vê profiles sem contexto de sessão
-- (como na 013): a role do gateway lê profiles e insere client_wallets.
-- backfill:start
set local role auth_profile_lookup;
insert into client_wallets (client_profile_id, bureau_id)
  select id, bureau_id from profiles where role = 'client'
  on conflict (client_profile_id) do nothing;
reset role;
-- backfill:end
