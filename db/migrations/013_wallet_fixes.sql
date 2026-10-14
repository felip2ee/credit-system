-- M3a: correções da revisão final. A 012 já foi aplicada e não muda.
-- 1) Carteira dos Bureaus que já existiam: o insert da 012 não via nenhuma linha de bureaus, pois o dono
--    tem RLS forçado e não há contexto de sessão na migração. A role do gateway (009) lê bureaus e insere wallets.
-- 2) wallet_apply recusa chaves "pix:": esse prefixo é do crédito do webhook e não pode colidir com a sessão.
-- 3) apply_asaas_payment grava no extrato uma referência neutra (pix_charge:<id>), não o id do Asaas.

-- backfill:start
set local role auth_profile_lookup;
insert into wallets (bureau_id) select id from bureaus on conflict (bureau_id) do nothing;
reset role;
-- backfill:end

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
  if p_idempotency_key like 'pix:%' then
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
        'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
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
