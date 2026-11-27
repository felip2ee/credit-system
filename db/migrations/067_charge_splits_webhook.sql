-- Webhook do Asaas atualiza charge_splits (065) a partir de payment.split[] dos eventos de split, estorno e chargeback.
-- Função definer (dono auth_profile_lookup), EXECUTE só para app_webhook. Idempotente: só grava quando o status muda.
-- Transições: pending -> done | refused | refunded; done -> refunded. refused, refunded e reversal_failed não mudam.
-- O Asaas não tem evento PAYMENT_SPLIT_REFUSED: a recusa chega como item com status REFUSED (ou CANCELLED) em payment.split.
-- Auditoria: charge_split.done | refused | refunded, com o walletId mascarado (4 últimos). Linha de sócio vai com bureau_id nulo.
-- Não mexe em asaas_webhook_events_result_check.

create policy audit_logs_charge_split_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('charge_split.done', 'charge_split.refused', 'charge_split.refunded')
  and support_session_id is null
  and user_id is null
  and table_name = 'charge_splits'
  and exists (
    select 1 from charge_splits s
     where s.id = audit_logs.record_id
       and audit_logs.action = 'charge_split.' || s.status
       and ((s.beneficiary_kind = 'partner' and audit_logs.bureau_id is null)
         or (s.beneficiary_kind <> 'partner' and audit_logs.bureau_id = s.bureau_id))
  )
);

-- p_splits: o array payment.split do evento (itens { id, walletId, status }). Retorna:
--   unknown_charge: nenhuma cobrança com esse id do Asaas;
--   updated: pelo menos uma linha mudou de status;
--   unchanged: reenvio, item sem linha, ou status sem transição.
create function apply_charge_split_event(p_event_id text, p_asaas_payment_id text, p_splits jsonb)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge_id uuid;
  v_item jsonb;
  v_row public.charge_splits%rowtype;
  v_new text;
  v_changed boolean := false;
begin
  select id into v_charge_id from public.pix_charges where asaas_payment_id = p_asaas_payment_id;
  if not found then
    return 'unknown_charge';
  end if;
  if jsonb_typeof(p_splits) is distinct from 'array' then
    return 'unchanged';
  end if;

  for v_item in select value from jsonb_array_elements(p_splits) loop
    if jsonb_typeof(v_item) is distinct from 'object' or nullif(btrim(v_item ->> 'id'), '') is null then
      continue;
    end if;
    v_new := case v_item ->> 'status'
      when 'DONE' then 'done'
      when 'REFUSED' then 'refused'
      when 'CANCELLED' then 'refused'
      when 'REFUNDED' then 'refunded'
    end;

    -- Pelo splitId; no primeiro evento a linha ainda não tem o id: casa pelo walletId.
    select * into v_row from public.charge_splits
     where pix_charge_id = v_charge_id and asaas_split_id = v_item ->> 'id'
     for update;
    if not found then
      select * into v_row from public.charge_splits
       where pix_charge_id = v_charge_id and asaas_split_id is null
         and payout_method = 'asaas' and asaas_wallet_id = v_item ->> 'walletId'
       order by created_at, id limit 1
       for update;
      if not found then
        continue;
      end if;
      update public.charge_splits set asaas_split_id = v_item ->> 'id' where id = v_row.id;
    end if;

    if v_new is null
       or not ((v_row.status = 'pending' and v_new in ('done', 'refused', 'refunded'))
            or (v_row.status = 'done' and v_new = 'refunded')) then
      continue;
    end if;

    update public.charge_splits set status = v_new where id = v_row.id;
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (
      case when v_row.beneficiary_kind = 'partner' then null else v_row.bureau_id end,
      null, 'charge_split.' || v_new, 'charge_splits', v_row.id,
      jsonb_build_object(
        'event_id', p_event_id,
        'pix_charge_id', v_charge_id,
        'beneficiary_kind', v_row.beneficiary_kind,
        'from_status', v_row.status,
        'wallet', case when v_row.asaas_wallet_id is null then null else '***' || right(v_row.asaas_wallet_id, 4) end,
        'split_id', v_item ->> 'id'));
    v_changed := true;
  end loop;

  return case when v_changed then 'updated' else 'unchanged' end;
end
$$;

alter function apply_charge_split_event(text, text, jsonb) owner to auth_profile_lookup;
revoke all on function apply_charge_split_event(text, text, jsonb) from public;
grant execute on function apply_charge_split_event(text, text, jsonb) to app_webhook;
