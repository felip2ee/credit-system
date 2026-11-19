-- Cupons de desconto do Bureau (esquema). Spec: docs/superpowers/specs/2026-11-19-cupons-desconto-design.md.
-- 1) coupons, coupon_products, coupon_redemptions, com RLS: só o admin do Bureau lê e escreve em coupons e
--    coupon_products; coupon_redemptions é só leitura para o admin (as funções do banco gravam).
-- 2) order_settlements ganha coupon_id e discount. Só com cupom o preço pode ser 0 ou menor que o custo.
-- 3) bureau_payable_entries ganha coupon_cost (−) e coupon_refund (+), sempre com order_ref. Como o estorno (reversal),
--    contam na hora, sem retenção: payable_buckets e create_payout os somam e payout_items os aceita.
-- A 047 já foi aplicada e não muda. As regras de dinheiro (reserva, captura, liberação) vêm na 049.

-- Código sempre em maiúsculas e sem espaços nas pontas; o check abaixo recusa o que sobrar fora do formato.
create function coupons_normalize_code()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.code := pg_catalog.upper(pg_catalog.btrim(new.code));
  return new;
end
$$;

create table coupons (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  code text not null check (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind text not null check (kind in ('percent', 'fixed')),
  value numeric(15,2) not null,
  all_products boolean not null,
  max_uses integer check (max_uses is null or max_uses > 0),
  max_uses_per_client integer check (max_uses_per_client is null or max_uses_per_client > 0),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  active boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint coupons_value check (
    (kind = 'percent' and value between 0.01 and 100)
    or (kind = 'fixed' and value > 0 and value <= 99999999.99)
  ),
  constraint coupons_validity check (valid_until is null or valid_until > valid_from),
  -- Chave alvo das FKs compostas: a redenção e o pedido só apontam para cupom do mesmo Bureau.
  constraint coupons_bureau_id_key unique (bureau_id, id),
  -- Único por Bureau sem diferenciar maiúsculas: o código já fica em maiúsculas pelo gatilho.
  constraint coupons_bureau_code_key unique (bureau_id, code),
  foreign key (bureau_id, created_by) references profiles(bureau_id, id)
);

create trigger coupons_normalize_code before insert or update on coupons
  for each row execute function coupons_normalize_code();

-- Só tem linhas se coupons.all_products é falso. Com all_products verdadeiro a regra ignora esta tabela.
create table coupon_products (
  coupon_id uuid not null,
  bureau_id uuid not null,
  product_id uuid not null references products(id),
  primary key (coupon_id, product_id),
  foreign key (bureau_id, coupon_id) references coupons(bureau_id, id)
);

create index coupon_products_bureau_idx on coupon_products(bureau_id);

-- Um uso do cupom por pedido. Conta enquanto está reserved ou consumed.
-- FK para profiles, não para client_wallets: a FK trava a carteira com KEY SHARE (veja order_settlements, 015).
create table coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null,
  bureau_id uuid not null,
  client_profile_id uuid not null,
  order_ref uuid not null unique references order_settlements(order_ref),
  discount numeric(15,2) not null check (discount >= 0 and discount <= 99999999.99),
  funded_wallet numeric(15,2) not null default 0 check (funded_wallet >= 0 and funded_wallet <= 99999999.99),
  funded_payable numeric(15,2) not null default 0 check (funded_payable >= 0 and funded_payable <= 99999999.99),
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint coupon_redemptions_closed check ((status = 'reserved') = (closed_at is null)),
  foreign key (bureau_id, coupon_id) references coupons(bureau_id, id),
  foreign key (bureau_id, client_profile_id) references profiles(bureau_id, id)
);

create index coupon_redemptions_coupon_idx on coupon_redemptions(coupon_id) where status in ('reserved', 'consumed');
create index coupon_redemptions_coupon_client_idx on coupon_redemptions(coupon_id, client_profile_id)
  where status in ('reserved', 'consumed');
create index coupon_redemptions_bureau_idx on coupon_redemptions(bureau_id, created_at desc);

-- Só a transição reserved -> consumed | released é permitida; nenhum outro campo muda e nada se apaga.
create function coupon_redemptions_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'reserved'
     and new.status in ('consumed', 'released')
     and (to_jsonb(new) - 'status' - 'closed_at') = (to_jsonb(old) - 'status' - 'closed_at') then
    return new;
  end if;
  raise exception 'coupon_redemptions allows only the close transition' using errcode = 'check_violation';
end
$$;

create trigger coupon_redemptions_guard before update or delete on coupon_redemptions
  for each row execute function coupon_redemptions_guard();
create trigger coupon_redemptions_no_truncate before truncate on coupon_redemptions
  for each statement execute function coupon_redemptions_guard();

-- Pedido com cupom. O preço pago pode ser 0 e menor que o custo só com coupon_id. Sem cupom, as regras de antes valem.
alter table order_settlements add column coupon_id uuid;
alter table order_settlements add column discount numeric(15,2) not null default 0
  check (discount >= 0 and discount <= 99999999.99);
alter table order_settlements add constraint order_settlements_coupon_fk
  foreign key (bureau_id, coupon_id) references coupons(bureau_id, id);
alter table order_settlements add constraint order_settlements_coupon_shape
  check (coupon_id is not null or discount = 0);
alter table order_settlements add constraint order_settlements_coupon_online
  check (coupon_id is null or mode = 'online');
create index order_settlements_coupon_idx on order_settlements(coupon_id) where coupon_id is not null;

alter table order_settlements drop constraint order_settlements_price_check;
alter table order_settlements drop constraint order_settlements_price_cost;
alter table order_settlements add constraint order_settlements_price_range
  check (price >= 0 and price <= 99999999.99);
alter table order_settlements add constraint order_settlements_price_positive
  check (price > 0 or coupon_id is not null);
alter table order_settlements add constraint order_settlements_price_cost
  check (price >= cost or coupon_id is not null);

-- Valor a repassar: coupon_cost (−) é o que o cupom tirou do valor liberado na reserva; coupon_refund (+) devolve.
alter table bureau_payable_entries drop constraint bureau_payable_entries_kind_check;
alter table bureau_payable_entries add constraint bureau_payable_entries_kind_check
  check (kind in ('accrual', 'reversal', 'payout', 'coupon_cost', 'coupon_refund'));
alter table bureau_payable_entries drop constraint bureau_payable_entries_amount;
alter table bureau_payable_entries add constraint bureau_payable_entries_amount check (
  abs(amount) <= 99999999.99
  and (
    (kind in ('accrual', 'coupon_refund') and amount > 0)
    or (kind in ('reversal', 'payout', 'coupon_cost') and amount < 0)
  )
);
alter table bureau_payable_entries add constraint bureau_payable_entries_coupon_order
  check (kind not in ('coupon_cost', 'coupon_refund') or order_ref is not null);
-- Um pedido gera no máximo um coupon_cost e um coupon_refund.
create unique index bureau_payable_entries_coupon_cost_order_idx on bureau_payable_entries(order_ref)
  where kind = 'coupon_cost';
create unique index bureau_payable_entries_coupon_refund_order_idx on bureau_payable_entries(order_ref)
  where kind = 'coupon_refund';

-- O repasse leva os lançamentos de cupom como leva o estorno: na hora, de qualquer data.
create or replace function payout_items_check_entry()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.bureau_payable_entries e
     where e.id = new.entry_id and e.bureau_id = new.bureau_id
       and e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
  ) then
    raise exception 'payout_items accepts only an accrual, reversal or coupon entry of the same Bureau'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

-- Corpo da 047; muda só: coupon_cost e coupon_refund entram e contam como liberados (como o reversal).
-- Quem garante que coupon_cost nunca deixa o saldo liberado abaixo de zero é a reserva do pedido (049).
create or replace function payable_buckets(p_bureau_id uuid)
returns table (released numeric, retained numeric, debt numeric, in_payout numeric, next_release_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_days integer := public.payable_retention_days();
  v_limit timestamptz;
begin
  if not public.app_context_present()
     or p_bureau_id is null
     or not (
       (public.app_user_role() in ('bureau_admin', 'operator')
         and p_bureau_id = public.app_bureau_id() and (select public.app_is_staff()))
       or (public.app_user_role() = 'superadmin' and public.app_support_session_id() is null)
     ) then
    return;
  end if;

  v_limit := pg_catalog.now() - pg_catalog.make_interval(days => v_days);
  return query
    with t as (
      select e.amount, e.kind, e.created_at, i.entry_id as item_id, p.status as payout_status
        from public.bureau_payable_entries e
        left join public.payout_items i on i.entry_id = e.id
        left join public.payouts p on p.id = i.payout_id
       where e.bureau_id = p_bureau_id
         and e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
    ), s as (
      select coalesce(sum(amount) filter (
               where item_id is null and (kind <> 'accrual' or created_at <= v_limit)), 0) as free_sum,
             coalesce(sum(amount) filter (
               where item_id is null and kind = 'accrual' and created_at > v_limit), 0) as retained_sum,
             coalesce(sum(amount) filter (where payout_status = 'open'), 0) as open_sum,
             min(created_at) filter (
               where item_id is null and kind = 'accrual' and created_at > v_limit) as first_retained
        from t
    )
    select greatest(0, s.free_sum)::numeric(15,2),
           s.retained_sum::numeric(15,2),
           greatest(0, -s.free_sum)::numeric(15,2),
           s.open_sum::numeric(15,2),
           s.first_retained + pg_catalog.make_interval(days => v_days)
      from s;
end
$$;

-- Corpo da 047; muda só: coupon_cost e coupon_refund entram e valem de qualquer data (como o reversal).
create or replace function create_payout(p_bureau_id uuid, p_cutoff_at timestamptz)
returns table (ok boolean, reason text, payout_id uuid, amount numeric)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_amount numeric;
  v_payout uuid;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_cutoff_at is null then
    return query select false, 'invalid_cutoff'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_bureau_id is null or not exists (select 1 from public.bureaus b where b.id = p_bureau_id) then
    return query select false, 'not_found'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_cutoff_at > pg_catalog.now() - pg_catalog.make_interval(days => public.payable_retention_days()) then
    return query select false, 'cutoff_within_retention'::text, null::uuid, null::numeric;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payout:' || p_bureau_id::text, 0));

  -- Estorno e lançamentos de cupom contam sempre; acréscimo só até o corte (que já respeita a retenção).
  select array_agg(e.id), sum(e.amount) into v_ids, v_amount
    from public.bureau_payable_entries e
   where e.bureau_id = p_bureau_id
     and e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
     and (e.kind <> 'accrual' or e.created_at <= p_cutoff_at)
     and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
  if v_ids is null or v_amount <= 0 then
    return query select false, 'nothing_to_pay'::text, null::uuid, null::numeric;
    return;
  end if;

  insert into public.payouts (bureau_id, cutoff_at, amount, created_by)
  values (p_bureau_id, p_cutoff_at, v_amount, public.app_user_id())
  returning id into v_payout;
  insert into public.payout_items (payout_id, entry_id, bureau_id)
  select v_payout, e.id, e.bureau_id
    from public.bureau_payable_entries e where e.id = any(v_ids);

  return query select true, null::text, v_payout, v_amount;
end
$$;

-- order_settlements: o dono das funções passa a gravar também coupon_id e discount (no insert).
grant insert (coupon_id, discount) on order_settlements to auth_profile_lookup;

-- Dono, revoke e grant de tudo que a 048 cria.
alter table coupons owner to schema_owner;
alter table coupon_products owner to schema_owner;
alter table coupon_redemptions owner to schema_owner;
alter function coupons_normalize_code() owner to schema_owner;
alter function coupon_redemptions_guard() owner to schema_owner;
revoke all on function coupons_normalize_code() from public;
revoke all on function coupon_redemptions_guard() from public;

revoke all on coupons, coupon_products, coupon_redemptions from public, app_runtime, auth_profile_lookup;
grant select, insert,
  update (code, kind, value, all_products, max_uses, max_uses_per_client, valid_from, valid_until, active)
  on coupons to app_runtime;
grant select, insert, delete on coupon_products to app_runtime;
grant select on coupon_redemptions to app_runtime;
grant select on coupons, coupon_products, coupon_redemptions to backup_reader;

-- Dono das funções (reserva, captura, liberação na 049): lê cupons e grava a redenção.
grant select on coupons, coupon_products to auth_profile_lookup;
grant select, insert, update (status, closed_at) on coupon_redemptions to auth_profile_lookup;

alter table coupons enable row level security;
alter table coupons force row level security;
alter table coupon_products enable row level security;
alter table coupon_products force row level security;
alter table coupon_redemptions enable row level security;
alter table coupon_redemptions force row level security;

-- Só o admin do Bureau lê e escreve. O cliente não lê cupom: usa só pelas funções do banco.
create policy coupons_admin_select on coupons for select
  using (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));
create policy coupons_admin_insert on coupons for insert
  with check (
    bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin'
    and (select app_is_staff()) and created_by = app_user_id()
  );
create policy coupons_admin_update on coupons for update
  using (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));

create policy coupon_products_admin_select on coupon_products for select
  using (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));
create policy coupon_products_admin_insert on coupon_products for insert
  with check (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));
create policy coupon_products_admin_delete on coupon_products for delete
  using (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));

create policy coupon_redemptions_admin_select on coupon_redemptions for select
  using (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()));

create policy coupons_gateway_select on coupons for select to auth_profile_lookup using (true);
create policy coupon_products_gateway_select on coupon_products for select to auth_profile_lookup using (true);
create policy coupon_redemptions_gateway_select on coupon_redemptions for select to auth_profile_lookup
  using (true);
create policy coupon_redemptions_gateway_insert on coupon_redemptions for insert to auth_profile_lookup
  with check (true);
create policy coupon_redemptions_gateway_update on coupon_redemptions for update to auth_profile_lookup
  using (true) with check (true);
