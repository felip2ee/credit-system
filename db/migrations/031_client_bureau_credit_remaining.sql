-- Crédito do Bureau ainda não gasto pelo cliente (029 e 030 já aplicadas: nada delas muda).
-- O limite de débito da 030 usava o líquido dos ajustes, mas crédito é fungível: o Bureau credita 50, o cliente gasta 50
-- em pedidos, recarrega 100 por PIX e o líquido seguia 50, deixando o Bureau tirar PIX do cliente.
-- client_wallets.bureau_credit_remaining guarda o que o Bureau creditou e ainda está lá: adjustment_credit soma,
-- adjustment_debit subtrai e capture consome primeiro o crédito do Bureau (greatest(restante - valor, 0)). Os outros
-- kinds não o tocam. O débito é limitado a least(restante, disponível), lido sob a trava da carteira do cliente.
-- Backfill: least(líquido dos ajustes, disponível). Sem histórico de capturas por origem não há conta exata; o teto
-- pelo disponível é o limite seguro, e ainda não há dado de produção.

alter table client_wallets add column bureau_credit_remaining numeric(15,2) not null default 0
  check (bureau_credit_remaining >= 0);
grant update (bureau_credit_remaining) on client_wallets to auth_profile_lookup;

update client_wallets w
   set bureau_credit_remaining = greatest(least(a.net, w.available), 0)
  from (
    select client_profile_id,
           sum(case direction when 'credit' then amount else -amount end) as net
      from client_balance_adjustments
     group by client_profile_id
  ) a
 where a.client_profile_id = w.client_profile_id;

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
  v_remaining numeric;
  v_remaining_after numeric;
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

  select bureau_id, available, reserved, bureau_credit_remaining into v_bureau_id, v_available, v_reserved, v_remaining
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
  v_remaining_after := v_remaining;
  case p_kind
    when 'topup', 'commission_credit' then
      v_available_after := v_available + p_amount;
    when 'adjustment_credit' then
      v_available_after := v_available + p_amount;
      v_remaining_after := v_remaining + p_amount;
    when 'adjustment_debit' then
      -- Só o disponível: a reserva de pedidos em andamento nunca é tocada por um ajuste.
      v_available_after := v_available - p_amount;
      v_remaining_after := v_remaining - p_amount;
    when 'reserve' then
      v_available_after := v_available - p_amount;
      v_reserved_after := v_reserved + p_amount;
    when 'capture' then
      v_reserved_after := v_reserved - p_amount;
      -- O crédito do Bureau é gasto primeiro: o que o cliente consome some do que o Bureau ainda pode retirar.
      v_remaining_after := greatest(v_remaining - p_amount, 0);
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
  update public.client_wallets
     set available = v_available_after, reserved = v_reserved_after, bureau_credit_remaining = v_remaining_after
   where client_profile_id = p_client_profile_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

create or replace function adjust_client_balance(
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
  v_client_active boolean;
  v_client_anonymized timestamptz;
  v_bureau_credit numeric;
  v_bureau_available numeric;
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'bureau_admin'
     or public.app_support_session_id() is not null
     or v_user is null or v_bureau is null
     or not exists (select 1 from public.profiles p
                     where p.id = v_user and p.role = 'bureau_admin' and p.bureau_id = v_bureau and p.is_active)
     or not exists (select 1 from public.bureaus b where b.id = v_bureau and b.status = 'active') then
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
  -- Documento no motivo: 11 dígitos seguidos ou CPF/CNPJ formatado. O motivo vai ao extrato do cliente e à auditoria.
  if v_reason is null or char_length(v_reason) not between 5 and 500
     or v_reason ~ '\d{11,}' or v_reason ~ '\d{3}\.\d{3}\.\d{3}-\d{2}' or v_reason ~ '\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}' then
    return query select false, 'invalid_reason'::text, null::uuid;
    return;
  end if;
  -- Ordem de travas: perfil do cliente (for share), carteira do cliente, carteira do Bureau. A anonimização trava o perfil
  -- "for no key update": uma das duas espera a outra, e o estado é relido sob a trava. Ela só lê as carteiras, sem travá-las,
  -- então não há ciclo.
  select p.is_active, p.anonymized_at into v_client_active, v_client_anonymized
    from public.profiles p
   where p.id = p_client_profile_id and p.role = 'client' and p.bureau_id = v_bureau
     for share;
  if not found or v_client_anonymized is not null or not v_client_active then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;

  -- Sob as travas das carteiras o saldo é conferido, então nenhum lançamento falha por saldo depois que outro já foi gravado.
  select available, bureau_credit_remaining into v_client_available, v_bureau_credit from public.client_wallets
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
  if p_direction = 'debit' then
    -- O Bureau remove só o que creditou e o cliente ainda não gastou (bureau_credit_remaining, lido sob a trava da carteira)
    -- e nunca mais que o disponível: recarga paga pelo cliente nunca sai por aqui.
    if p_amount > v_bureau_credit then
      return query select false, 'exceeds_bureau_credit'::text, null::uuid;
      return;
    end if;
    if p_amount > v_client_available then
      return query select false, 'insufficient_client_funds'::text, null::uuid;
      return;
    end if;
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
