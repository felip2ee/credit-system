-- M3a: carteira pré-paga do Bureau e recarga PIX.
-- wallets guarda o saldo; ledger_entries guarda a verdade (só INSERT, trigger bloqueia UPDATE/DELETE).
-- A role de runtime só lê: toda escrita passa por wallet_apply (com sessão) ou apply_asaas_payment
-- (webhook, sem sessão). As duas são SECURITY DEFINER com dono auth_profile_lookup (NOBYPASSRLS),
-- como em 009, e chamam wallet_post_entry, o único código que trava a carteira e grava o lançamento.
-- Exceção ao M1: o superadmin sem suporte lê wallets e ledger_entries de qualquer Bureau.

create table wallets (
  bureau_id uuid primary key references bureaus(id),
  available numeric(15,2) not null default 0 check (available >= 0),
  reserved numeric(15,2) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now()
);

create trigger wallets_updated_at before update on wallets
  for each row execute function set_updated_at();

-- seq ordena o extrato: created_at é o horário da transação e repete entre lançamentos dela.
create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  bureau_id uuid not null references bureaus(id),
  kind text not null check (kind in ('topup', 'reserve', 'capture', 'release', 'adjustment')),
  amount numeric(15,2) not null,
  available_after numeric(15,2) not null check (available_after >= 0),
  reserved_after numeric(15,2) not null check (reserved_after >= 0),
  idempotency_key text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
  reference text,
  reason text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (bureau_id, idempotency_key),
  constraint ledger_entries_amount_range check (
    abs(amount) <= 99999999.99 and (amount > 0 or (kind = 'adjustment' and amount <> 0))
  ),
  constraint ledger_entries_adjustment_reason check (kind <> 'adjustment' or btrim(reason) <> '')
);

create index ledger_entries_bureau_seq_idx on ledger_entries(bureau_id, seq desc);

create function ledger_entries_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'ledger_entries is immutable' using errcode = 'check_violation';
end
$$;

create trigger ledger_entries_immutable before update or delete on ledger_entries
  for each row execute function ledger_entries_immutable();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function ledger_entries_immutable();

create table pix_charges (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  asaas_payment_id text not null unique check (btrim(asaas_payment_id) <> ''),
  amount numeric(15,2) not null check (amount >= 10.00 and amount <= 5000.00),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  pix_payload text not null,
  expires_at timestamptz not null,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (bureau_id, requested_by) references profiles(bureau_id, id)
);

create index pix_charges_bureau_created_idx on pix_charges(bureau_id, created_at desc);

-- bureau_id é nulo quando o evento cita uma cobrança desconhecida (não há Bureau a que ligá-lo).
create table asaas_webhook_events (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid references bureaus(id),
  event_id text not null unique check (btrim(event_id) <> ''),
  event_type text not null check (btrim(event_type) <> ''),
  asaas_payment_id text,
  payload jsonb not null,
  result text not null check (result in ('received', 'credited', 'duplicate', 'ignored', 'unknown_charge')),
  received_at timestamptz not null default now()
);

alter table wallets enable row level security;
alter table wallets force row level security;
alter table ledger_entries enable row level security;
alter table ledger_entries force row level security;
alter table pix_charges enable row level security;
alter table pix_charges force row level security;
alter table asaas_webhook_events enable row level security;
alter table asaas_webhook_events force row level security;

create policy wallets_select on wallets for select using (
  (bureau_id = app_bureau_id() and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy ledger_entries_select on ledger_entries for select using (
  (bureau_id = app_bureau_id() and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy pix_charges_select on pix_charges for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy pix_charges_admin_insert on pix_charges for insert with check (
  bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff())
  and requested_by = app_user_id() and status = 'pending'
);
create policy asaas_webhook_events_select on asaas_webhook_events for select using (
  bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff())
);

-- Cada Bureau nasce com a carteira zerada.
create function wallets_create_for_bureau()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.wallets (bureau_id) values (new.id);
  return new;
end
$$;

create trigger bureaus_create_wallet after insert on bureaus
  for each row execute function wallets_create_for_bureau();

-- Único código que escreve na carteira: trava a linha, valida, insere o lançamento, atualiza o saldo.
-- Não autoriza ninguém: só wallet_apply e apply_asaas_payment a chamam.
create function wallet_post_entry(
  p_bureau_id uuid,
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
  v_available numeric;
  v_reserved numeric;
  v_available_after numeric;
  v_reserved_after numeric;
  v_entry public.ledger_entries;
  v_id uuid;
begin
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'adjustment') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or abs(p_amount) > 99999999.99
     or (p_kind = 'adjustment' and p_amount = 0) or (p_kind <> 'adjustment' and p_amount <= 0) then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select available, reserved into v_available, v_reserved
    from public.wallets where bureau_id = p_bureau_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.ledger_entries
   where bureau_id = p_bureau_id and idempotency_key = p_idempotency_key;
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
    when 'adjustment' then
      v_available_after := v_available + p_amount;
  end case;

  if v_available_after < 0 then
    return query select false, 'insufficient_balance'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if v_reserved_after < 0 then
    return query select false, 'reservation_exceeded'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.ledger_entries
    (bureau_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by)
  values
    (p_bureau_id, p_kind, p_amount, v_available_after, v_reserved_after, p_idempotency_key, p_reference, p_reason, p_created_by)
  returning id into v_id;
  update public.wallets set available = v_available_after, reserved = v_reserved_after
   where bureau_id = p_bureau_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

-- Caminho da sessão: reserve, capture, release (qualquer identidade do Bureau, decisão 4 do plano)
-- e adjustment (só superadmin, com motivo). topup nunca passa por aqui.
create function wallet_apply(
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

-- Caminho do webhook (sem sessão). O valor creditado vem de pix_charges.amount, nunca do payload.
-- Pagamento de cobrança pending ou expired credita (o dinheiro já entrou); cancelled não credita.
-- A auditoria usa user_id = pix_charges.requested_by, pois o webhook não tem usuário.
create function apply_asaas_payment(
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
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

  insert into public.asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
  values (v_charge.bureau_id, p_event_id, p_event_type, p_asaas_payment_id, coalesce(p_payload, '{}'::jsonb), 'received')
  on conflict (event_id) do nothing
  returning id into v_event_row;
  if v_event_row is null then
    return 'duplicate';
  end if;

  if v_charge.id is null then
    v_result := 'unknown_charge';
  elsif p_event_type not in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    v_result := 'ignored';
  else
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status = 'paid' then
      v_result := 'duplicate';
    elsif v_charge.status = 'cancelled' then
      v_result := 'ignored';
    else
      update public.pix_charges set status = 'paid' where id = v_charge.id;
      select * into v_post from public.wallet_post_entry(
        v_charge.bureau_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
        v_charge.asaas_payment_id, null, v_charge.requested_by);
      if not v_post.ok then
        raise exception 'wallet topup failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', 'ledger_entries', v_post.entry_id,
        jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id, 'amount', v_charge.amount::text));
      v_result := 'credited';
    end if;
  end if;

  update public.asaas_webhook_events set result = v_result where id = v_event_row;
  return v_result;
end
$$;

alter table wallets owner to schema_owner;
alter table ledger_entries owner to schema_owner;
alter table pix_charges owner to schema_owner;
alter table asaas_webhook_events owner to schema_owner;
alter function ledger_entries_immutable() owner to schema_owner;
alter function wallets_create_for_bureau() owner to auth_profile_lookup;
alter function wallet_post_entry(uuid, text, numeric, text, text, text, uuid) owner to auth_profile_lookup;
alter function wallet_apply(uuid, text, numeric, text, text, text) owner to auth_profile_lookup;
alter function apply_asaas_payment(text, text, text, jsonb) owner to auth_profile_lookup;

revoke all on function ledger_entries_immutable() from public;
revoke all on function wallets_create_for_bureau() from public;
revoke all on function wallet_post_entry(uuid, text, numeric, text, text, text, uuid) from public;
revoke all on function wallet_apply(uuid, text, numeric, text, text, text) from public;
revoke all on function apply_asaas_payment(text, text, text, jsonb) from public;
grant execute on function wallet_apply(uuid, text, numeric, text, text, text) to app_runtime;
grant execute on function apply_asaas_payment(text, text, text, jsonb) to app_runtime;

revoke all on wallets, ledger_entries, pix_charges, asaas_webhook_events
  from public, app_runtime, auth_profile_lookup;
grant select on wallets, ledger_entries, pix_charges to app_runtime;
grant insert (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by)
  on pix_charges to app_runtime;
-- O payload bruto fica fora do alcance da aplicação.
grant select (id, bureau_id, event_id, event_type, asaas_payment_id, result, received_at)
  on asaas_webhook_events to app_runtime;
grant select on wallets, ledger_entries, pix_charges, asaas_webhook_events to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select, insert (bureau_id), update (available, reserved) on wallets to auth_profile_lookup;
grant select, insert on ledger_entries to auth_profile_lookup;
grant select, update (status) on pix_charges to auth_profile_lookup;
grant select, insert, update (result) on asaas_webhook_events to auth_profile_lookup;
grant insert (bureau_id, user_id, action, table_name, record_id, metadata) on audit_logs to auth_profile_lookup;
-- audit_logs_insert (todas as roles) avalia o ramo catalog.cost.set da 011, que lê estas duas colunas.
grant select (set_by, created_at) on bureau_product_costs to auth_profile_lookup;

create policy wallets_gateway_select on wallets for select to auth_profile_lookup using (true);
create policy wallets_gateway_insert on wallets for insert to auth_profile_lookup with check (true);
create policy wallets_gateway_update on wallets for update to auth_profile_lookup
  using (true) with check (true);
create policy ledger_entries_gateway_select on ledger_entries for select to auth_profile_lookup
  using (true);
create policy ledger_entries_gateway_insert on ledger_entries for insert to auth_profile_lookup
  with check (true);
create policy pix_charges_gateway_select on pix_charges for select to auth_profile_lookup
  using (true);
create policy pix_charges_gateway_update on pix_charges for update to auth_profile_lookup
  using (true) with check (true);
create policy asaas_webhook_events_gateway_select on asaas_webhook_events for select to auth_profile_lookup
  using (true);
create policy asaas_webhook_events_gateway_insert on asaas_webhook_events for insert to auth_profile_lookup
  with check (true);
create policy asaas_webhook_events_gateway_update on asaas_webhook_events for update to auth_profile_lookup
  using (true) with check (true);

-- Auditoria do webhook: só o dono das funções (to auth_profile_lookup), só wallet.topup, e só junto de
-- um lançamento topup do mesmo Bureau e autor criado na mesma transação. A role de runtime não usa esta política.
create policy audit_logs_topup_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'wallet.topup'
  and table_name = 'ledger_entries'
  and support_session_id is null
  and bureau_id is not null
  and exists (
    select 1 from ledger_entries e
     where e.id = audit_logs.record_id
       and e.kind = 'topup'
       and e.bureau_id = audit_logs.bureau_id
       and e.created_by = audit_logs.user_id
       and e.created_at = now()
  )
);

-- Auditoria do ajuste (decisão 5 do plano): mantém o ramo catalog.cost.set da 011 sem mudança e
-- acrescenta wallet.adjust, só superadmin sem suporte, só junto do lançamento adjustment
-- (record_id) do mesmo Bureau e autor, criado na mesma transação.
drop policy audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs for insert with check (
  app_context_present()
  and user_id = app_user_id()
  and support_session_id is not distinct from app_support_session_id()
  and (
    (
      bureau_id is not distinct from app_bureau_id()
      and (bureau_id is null) = (app_user_role() = 'superadmin' and app_support_session_id() is null)
    )
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and action = 'catalog.cost.set'
      and table_name = 'products'
      and exists (
        select 1 from bureau_product_costs c
         where c.bureau_id = audit_logs.bureau_id
           and c.product_id = audit_logs.record_id
           and c.set_by = audit_logs.user_id
           and c.created_at = now()
           and (audit_logs.metadata ->> 'new_cost')::numeric = c.cost
      )
    )
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and action = 'wallet.adjust'
      and table_name = 'ledger_entries'
      and exists (
        select 1 from ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'adjustment'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
  ));

-- O superadmin relê os ajustes de carteira (bureau_id preenchido, sem suporte), como política adicional ao 004.
create policy audit_logs_select_wallet on audit_logs for select using (
  app_context_present()
  and app_user_role() = 'superadmin'
  and support_session_id is null
  and bureau_id is not null
  and action = 'wallet.adjust'
);

-- Carteira dos Bureaus que já existem.
insert into wallets (bureau_id) select id from bureaus;
