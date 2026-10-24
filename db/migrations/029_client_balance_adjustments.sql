-- Ajuste de saldo do cliente pelo Bureau.
-- 1) Livro do cliente: lançamentos adjustment_credit e adjustment_debit. Livro do Bureau: client_adjustment_out (o Bureau
--    paga o crédito do cliente) e client_adjustment_in (o débito do cliente volta ao Bureau). O kind 'adjustment' do
--    Bureau (012) fica como está: é o ajuste do superadmin, com sinal e auditoria wallet.adjust própria.
--    Os novos kinds nascem só em adjust_client_balance (wallet_apply e client_wallet_apply nunca os aceitam) e exigem motivo.
-- 2) client_balance_adjustments: um ajuste, imutável. O app_runtime lê tudo menos created_by (equipe do Bureau dono e o
--    próprio cliente, por RLS). O autor sai só pela função list_client_balance_adjustments, que serve a equipe.
-- 3) adjust_client_balance: só bureau_admin, fora de suporte, de um cliente do próprio Bureau. Dinheiro só por
--    client_wallet_post_entry e wallet_post_entry; a auditoria client_wallet.adjust nasce na mesma transação.
-- Ordem de travas: carteira do cliente -> carteira do Bureau. Nenhum outro caminho trava as duas carteiras na mesma
-- transação (reserve_order, capture_order, release_order e apply_asaas_payment travam uma só); a conversão de comissão
-- (028) trava a carteira do afiliado e a do cliente, nunca a do Bureau.

-- 1) Constraints de kind.
do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
   where conrelid = 'public.client_ledger_entries'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%''topup''%';
  execute format('alter table public.client_ledger_entries drop constraint %I', v_name);
  select conname into v_name from pg_constraint
   where conrelid = 'public.ledger_entries'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%''topup''%';
  execute format('alter table public.ledger_entries drop constraint %I', v_name);
end
$$;
alter table client_ledger_entries add constraint client_ledger_entries_kind_check
  check (kind in ('topup', 'reserve', 'capture', 'release', 'reversal', 'commission_credit',
                  'adjustment_credit', 'adjustment_debit'));
alter table client_ledger_entries add constraint client_ledger_entries_adjustment_reason
  check (kind not in ('adjustment_credit', 'adjustment_debit') or btrim(reason) <> '');
alter table ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('topup', 'reserve', 'capture', 'release', 'adjustment', 'reversal',
                  'client_adjustment_out', 'client_adjustment_in'));
alter table ledger_entries add constraint ledger_entries_client_adjustment_reason
  check (kind not in ('client_adjustment_out', 'client_adjustment_in') or btrim(reason) <> '');

-- Núcleo da carteira do Bureau (018) com os kinds novos. Dono, search_path e grants não mudam.
create or replace function wallet_post_entry(
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
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'adjustment', 'reversal',
                    'client_adjustment_out', 'client_adjustment_in') then
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
    when 'topup', 'client_adjustment_in' then
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
    when 'client_adjustment_out' then
      v_available_after := v_available - p_amount;
    when 'reversal' then
      -- O dinheiro estornado sai do disponível; o que faltar sai da reserva, que deixa de ter lastro.
      v_available_after := greatest(v_available - p_amount, 0);
      v_reserved_after := v_reserved - greatest(p_amount - v_available, 0);
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

-- Núcleo da carteira do cliente (026) com os kinds novos. Dono, search_path e grants não mudam.
create or replace function client_wallet_post_entry(
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
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'reversal', 'commission_credit',
                    'adjustment_credit', 'adjustment_debit') then
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
    when 'topup', 'commission_credit', 'adjustment_credit' then
      v_available_after := v_available + p_amount;
    when 'adjustment_debit' then
      -- Só o disponível: a reserva de pedidos em andamento nunca é tocada por um ajuste.
      v_available_after := v_available - p_amount;
    when 'reserve' then
      v_available_after := v_available - p_amount;
      v_reserved_after := v_reserved + p_amount;
    when 'capture' then
      v_reserved_after := v_reserved - p_amount;
    when 'release' then
      v_reserved_after := v_reserved - p_amount;
      v_available_after := v_available + p_amount;
    when 'reversal' then
      -- O dinheiro estornado sai do disponível; o que faltar sai da reserva, que deixa de ter lastro.
      v_available_after := greatest(v_available - p_amount, 0);
      v_reserved_after := v_reserved - greatest(p_amount - v_available, 0);
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

-- 2) O ajuste.
create table client_balance_adjustments (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  client_profile_id uuid not null,
  direction text not null check (direction in ('credit', 'debit')),
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  reason text not null check (char_length(btrim(reason, E' \t\r\n')) between 5 and 500),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  foreign key (bureau_id, client_profile_id) references profiles(bureau_id, id)
);

create index client_balance_adjustments_client_idx
  on client_balance_adjustments(client_profile_id, created_at desc);

create trigger client_balance_adjustments_immutable before update or delete on client_balance_adjustments
  for each row execute function append_only_guard();
create trigger client_balance_adjustments_no_truncate before truncate on client_balance_adjustments
  for each statement execute function append_only_guard();

alter table client_balance_adjustments owner to schema_owner;
alter table client_balance_adjustments enable row level security;
alter table client_balance_adjustments force row level security;

create policy client_balance_adjustments_select_staff on client_balance_adjustments for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy client_balance_adjustments_select_own on client_balance_adjustments for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
);

revoke all on client_balance_adjustments from public, app_runtime, auth_profile_lookup;
-- created_by fica de fora: o cliente não vê quem da equipe fez o ajuste.
grant select (id, bureau_id, client_profile_id, direction, amount, reason, created_at)
  on client_balance_adjustments to app_runtime;
grant select on client_balance_adjustments to backup_reader;
grant select, insert on client_balance_adjustments to auth_profile_lookup;

create policy client_balance_adjustments_gateway_select on client_balance_adjustments for select
  to auth_profile_lookup using (true);
create policy client_balance_adjustments_gateway_insert on client_balance_adjustments for insert
  to auth_profile_lookup with check (
    bureau_id = app_bureau_id() and created_by = app_user_id() and app_user_role() = 'bureau_admin'
  );

-- Auditoria: só esta ação, do bureau_admin do Bureau da sessão, sobre um ajuste dele. O metadata não leva documento.
create policy audit_logs_client_adjust_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'client_wallet.adjust' and table_name = 'client_balance_adjustments'
  and support_session_id is null
  and bureau_id = app_bureau_id() and user_id = app_user_id() and app_user_role() = 'bureau_admin'
  and exists (
    select 1 from client_balance_adjustments a
     where a.id = audit_logs.record_id and a.bureau_id = audit_logs.bureau_id and a.created_by = audit_logs.user_id)
);

-- 3) A função do ajuste. O valor chega como numeric: o texto do app não passa por ponto flutuante. p_request_id é o id do
--    ajuste e a base das chaves dos lançamentos: o mesmo pedido repetido não lança de novo.
create function adjust_client_balance(
  p_client_profile_id uuid, p_direction text, p_amount numeric, p_reason text, p_request_id uuid
)
returns table (ok boolean, reason text, adjustment_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_user uuid := public.app_user_id();
  v_bureau uuid := public.app_bureau_id();
  v_reason text := btrim(p_reason, E' \t\r\n');
  v_id uuid := p_request_id;
  v_existing public.client_balance_adjustments;
  v_client_available numeric;
  v_bureau_available numeric;
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'bureau_admin'
     or public.app_support_session_id() is not null
     or v_user is null or v_bureau is null
     or not exists (select 1 from public.profiles p
                     where p.id = v_user and p.role = 'bureau_admin' and p.bureau_id = v_bureau) then
    return query select false, 'not_allowed'::text, null::uuid;
    return;
  end if;
  if p_request_id is null then
    return query select false, 'invalid_request'::text, null::uuid;
    return;
  end if;
  if p_direction is null or p_direction not in ('credit', 'debit') then
    return query select false, 'invalid_direction'::text, null::uuid;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid;
    return;
  end if;
  if v_reason is null or char_length(v_reason) not between 5 and 500 then
    return query select false, 'invalid_reason'::text, null::uuid;
    return;
  end if;
  if not exists (select 1 from public.profiles p
                  where p.id = p_client_profile_id and p.role = 'client' and p.bureau_id = v_bureau
                    and p.anonymized_at is null) then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;

  -- Ordem de travas: carteira do cliente, depois a do Bureau. Sob as duas travas o saldo é conferido, então nenhum
  -- lançamento falha por saldo depois que outro já foi gravado.
  select available into v_client_available from public.client_wallets
   where client_profile_id = p_client_profile_id and bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  select available into v_bureau_available from public.wallets where bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  -- Repetição do mesmo pedido (clique duplo, reenvio): sob as travas, devolve o ajuste já feito sem lançar de novo,
  -- mesmo que o saldo tenha mudado desde então. O mesmo id com outro conteúdo ou de outro Bureau é conflito.
  select * into v_existing from public.client_balance_adjustments a where a.id = v_id;
  if found then
    if v_existing.bureau_id = v_bureau and v_existing.client_profile_id = p_client_profile_id
       and v_existing.direction = p_direction and v_existing.amount = p_amount
       and v_existing.reason = v_reason and v_existing.created_by = v_user then
      return query select true, null::text, v_id;
    else
      return query select false, 'request_conflict'::text, null::uuid;
    end if;
    return;
  end if;
  if p_direction = 'credit' and v_bureau_available < p_amount then
    return query select false, 'insufficient_bureau_funds'::text, null::uuid;
    return;
  end if;
  if p_direction = 'debit' and v_client_available < p_amount then
    return query select false, 'insufficient_client_funds'::text, null::uuid;
    return;
  end if;

  insert into public.client_balance_adjustments (id, bureau_id, client_profile_id, direction, amount, reason, created_by)
  values (v_id, v_bureau, p_client_profile_id, p_direction, p_amount, v_reason, v_user);

  -- O lançamento do cliente leva o próprio cliente como autor: o id da equipe não chega ao extrato dele.
  select * into v_post from public.client_wallet_post_entry(
    p_client_profile_id,
    case p_direction when 'credit' then 'adjustment_credit' else 'adjustment_debit' end,
    p_amount, 'adjustment:' || v_id::text || ':client', 'adjustment:' || v_id::text, v_reason, p_client_profile_id);
  if not v_post.ok then
    raise exception 'client wallet refused the adjustment: %', v_post.reason;
  end if;
  select * into v_post from public.wallet_post_entry(
    v_bureau,
    case p_direction when 'credit' then 'client_adjustment_out' else 'client_adjustment_in' end,
    p_amount, 'adjustment:' || v_id::text || ':bureau', 'adjustment:' || v_id::text, v_reason, v_user);
  if not v_post.ok then
    raise exception 'bureau wallet refused the adjustment: %', v_post.reason;
  end if;

  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user, 'client_wallet.adjust', 'client_balance_adjustments', v_id,
    jsonb_build_object('client_profile_id', p_client_profile_id, 'direction', p_direction,
                       'amount', p_amount::text, 'reason', v_reason));
  return query select true, null::text, v_id;
end
$$;

alter function adjust_client_balance(uuid, text, numeric, text, uuid) owner to auth_profile_lookup;
revoke all on function adjust_client_balance(uuid, text, numeric, text, uuid) from public;
grant execute on function adjust_client_balance(uuid, text, numeric, text, uuid) to app_runtime;

-- Histórico de ajustes de um cliente para a equipe do Bureau dono (com o nome de quem ajustou). O cliente e o resto: sem linha.
create function list_client_balance_adjustments(p_client_profile_id uuid, p_limit integer default 50)
returns table (id uuid, direction text, amount numeric, reason text, created_at timestamptz, author_name text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.id, a.direction, a.amount, a.reason, a.created_at, p.full_name
    from public.client_balance_adjustments a
    join public.profiles p on p.id = a.created_by
   where public.app_is_staff()
     and a.client_profile_id = p_client_profile_id
     and a.bureau_id = public.app_bureau_id()
   order by a.created_at desc, a.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

alter function list_client_balance_adjustments(uuid, integer) owner to auth_profile_lookup;
revoke all on function list_client_balance_adjustments(uuid, integer) from public;
grant execute on function list_client_balance_adjustments(uuid, integer) to app_runtime;
