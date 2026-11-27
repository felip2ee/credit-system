-- Correções da revisão do split no estorno (plano afiliado-bureaus, parte 1).
-- 1) apply_charge_split_event (072): ganha tipo do evento, installment e externalReference (os três com default).
--    reversal_failed -> refunded (o Asaas reverte de forma assíncrona). Em cobrança estornada, CANCELLED e REFUSED viram
--    refunded, nunca refused, e uma linha já refused também vira refunded. Parcela 2..n do cartão casa por
--    asaas_installment_id e walletId. Cobrança nossa ainda sem o id do pagamento devolve unbound_charge (o webhook
--    responde 500 e o Asaas reenvia); a de fora do sistema segue unknown_charge.
-- 2) reverse_cash_in_commission (079): linha asaas refused vira refunded; item CANCELLED também estorna; item DONE no
--    pedido de chargeback não vira reversal_failed (sem job de prazo: a linha fica done e o painel mostra "Reversão
--    pendente" até o Asaas informar).
-- 3) pix_charge_returned / charge_split_charge_state: "o dinheiro voltou" para o webhook e o painel. A cobrança de link
--    estornada continua paid. O superadmin não lê pix_charges (012/014): o painel lê só o estado por função definer.
-- 4) asaas_webhook_events.installment_id: o relatório de prejuízo casa o estorno de qualquer parcela sem ler o payload.

alter table asaas_webhook_events
  add column installment_id text generated always as (payload #>> '{payment,installment}') stored;
grant select (installment_id) on asaas_webhook_events to app_runtime;
create index asaas_webhook_events_installment_idx on asaas_webhook_events(installment_id) where installment_id is not null;
-- pix_charge_returned roda por linha do painel.
create index if not exists asaas_webhook_events_payment_idx on asaas_webhook_events(asaas_payment_id);

create function pix_charge_returned(p_charge_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.pix_charges c
     where c.id = p_charge_id
       and (c.status = 'refunded'
         or exists (select 1 from public.asaas_webhook_events e
                     where e.asaas_payment_id = c.asaas_payment_id and e.result = 'link_refund_ignored'
                       and e.event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'))))
$$;
alter function pix_charge_returned(uuid) owner to auth_profile_lookup;
revoke all on function pix_charge_returned(uuid) from public;

-- Estado da cobrança para o painel de repasses: 'refunded' quando o dinheiro voltou. Null fora do alcance da sessão
-- (equipe do próprio Bureau ou superadmin sem suporte, o mesmo corte de charge_splits_select).
create function charge_split_charge_state(p_charge_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case when public.pix_charge_returned(c.id) then 'refunded' else c.status end
    from public.pix_charges c
   where c.id = p_charge_id
     and public.app_context_present()
     and ((public.app_user_role() = 'superadmin' and public.app_support_session_id() is null)
       or (c.bureau_id = public.app_bureau_id() and public.app_is_staff()))
$$;
alter function charge_split_charge_state(uuid) owner to auth_profile_lookup;
revoke all on function charge_split_charge_state(uuid) from public;
grant execute on function charge_split_charge_state(uuid) to app_runtime;

-- p_splits: o array payment.split do evento (itens { id, walletId, status }). Retorna:
--   unbound_charge: a referência é de uma cobrança nossa que ainda não gravou o id do Asaas;
--   unknown_charge: nenhuma cobrança com esse id do Asaas;
--   updated: pelo menos uma linha mudou de status;
--   unchanged: reenvio, item sem linha, ou status sem transição.
drop function apply_charge_split_event(text, text, jsonb);
create function apply_charge_split_event(
  p_event_id text,
  p_asaas_payment_id text,
  p_splits jsonb,
  p_event_type text default null,
  p_asaas_installment_id text default null,
  p_external_reference text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_returned boolean;
  v_item jsonb;
  v_row public.charge_splits%rowtype;
  v_new text;
  v_changed boolean := false;
begin
  -- for share: serializa com o estorno de apply_asaas_payment (que trava a cobrança antes das linhas do split).
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id for share;
  if v_charge.id is null and nullif(btrim(p_asaas_installment_id), '') is not null then
    select * into v_charge from public.pix_charges where asaas_installment_id = p_asaas_installment_id for share;
  end if;
  if v_charge.id is null then
    -- Só pede reenvio se apply_asaas_payment ainda puder ligar a cobrança a este pagamento ou parcelamento.
    if p_external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      if exists (
        select 1 from public.pix_charges c
         where c.external_reference = p_external_reference::uuid
           and (c.asaas_payment_id is null
             or (c.billing_type = 'CREDIT_CARD' and c.asaas_installment_id is null
                 and nullif(btrim(p_asaas_installment_id), '') is not null))
      ) then
        return 'unbound_charge';
      end if;
    end if;
    return 'unknown_charge';
  end if;
  if jsonb_typeof(p_splits) is distinct from 'array' then
    return 'unchanged';
  end if;
  -- O tipo do evento conta: o webhook aplica o split antes de apply_asaas_payment marcar a cobrança.
  v_returned := coalesce(p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'), false)
    or public.pix_charge_returned(v_charge.id);

  for v_item in select value from jsonb_array_elements(p_splits) loop
    if jsonb_typeof(v_item) is distinct from 'object' or nullif(btrim(v_item ->> 'id'), '') is null then
      continue;
    end if;

    -- Pelo splitId; no primeiro evento a linha ainda não tem o id: casa pelo walletId.
    select * into v_row from public.charge_splits
     where pix_charge_id = v_charge.id and asaas_split_id = v_item ->> 'id'
     for update;
    if not found then
      select * into v_row from public.charge_splits
       where pix_charge_id = v_charge.id and asaas_split_id is null
         and payout_method = 'asaas' and asaas_wallet_id = v_item ->> 'walletId'
       order by created_at, id limit 1
       for update;
      if found then
        update public.charge_splits set asaas_split_id = v_item ->> 'id' where id = v_row.id;
      elsif v_charge.installments > 1 then
        -- Parcela 2..n: outro id de split, a mesma linha. O id gravado fica o da primeira.
        -- shortcut: uma linha por cobrança; o status é o do conjunto das parcelas (a recusa de uma parcela depois de
        -- done não aparece) e duas linhas com o mesmo walletId casam só a primeira.
        select * into v_row from public.charge_splits
         where pix_charge_id = v_charge.id and payout_method = 'asaas' and asaas_wallet_id = v_item ->> 'walletId'
         order by created_at, id limit 1
         for update;
        if not found then
          continue;
        end if;
      else
        continue;
      end if;
    end if;

    v_new := case
      when v_item ->> 'status' = 'DONE' then 'done'
      when v_item ->> 'status' = 'REFUNDED' then 'refunded'
      when v_item ->> 'status' in ('REFUSED', 'CANCELLED') then
        case when v_returned or v_row.status = 'reversal_failed' then 'refunded' else 'refused' end
    end;

    if v_new is null
       or not ((v_row.status = 'pending' and v_new in ('done', 'refused', 'refunded'))
            or (v_row.status in ('done', 'reversal_failed') and v_new = 'refunded')
            or (v_row.status = 'refused' and v_new = 'refunded' and v_returned)) then
      continue;
    end if;

    update public.charge_splits set status = v_new where id = v_row.id;
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (
      case when v_row.beneficiary_kind = 'partner' then null else v_row.bureau_id end,
      null, 'charge_split.' || v_new, 'charge_splits', v_row.id,
      jsonb_build_object(
        'event_id', p_event_id,
        'pix_charge_id', v_charge.id,
        'beneficiary_kind', v_row.beneficiary_kind,
        'from_status', v_row.status,
        'wallet', case when v_row.asaas_wallet_id is null then null else '***' || right(v_row.asaas_wallet_id, 4) end,
        'split_id', v_item ->> 'id'));
    v_changed := true;
  end loop;

  return case when v_changed then 'updated' else 'unchanged' end;
end
$$;

alter function apply_charge_split_event(text, text, jsonb, text, text, text) owner to auth_profile_lookup;
revoke all on function apply_charge_split_event(text, text, jsonb, text, text, text) from public;
grant execute on function apply_charge_split_event(text, text, jsonb, text, text, text) to app_webhook;

-- Dono e grants vêm da 079; create or replace os mantém.
create or replace function reverse_cash_in_commission(p_charge_id uuid, p_event_type text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_charge public.pix_charges;
  v_line public.charge_splits;
  v_commission public.affiliate_commissions;
  v_accrual public.bureau_payable_entries;
  v_post record;
  v_items jsonb;
  v_item jsonb;
  v_new text;
  v_entry_id uuid;
  v_remaining numeric;
  v_done integer := 0;
begin
  select * into v_charge from public.pix_charges where id = p_charge_id for share;
  if not found or v_charge.status not in ('paid', 'refunded') then
    return 0;
  end if;
  v_items := case when jsonb_typeof(p_payload #> '{payment,split}') = 'array' then p_payload #> '{payment,split}' end;

  for v_line in
    select * from public.charge_splits s
     where s.pix_charge_id = p_charge_id
       and (s.status in ('pending', 'done') or (s.status = 'refused' and s.payout_method = 'asaas'))
     order by s.beneficiary_id, s.id
       for update
  loop
    v_new := null;

    if v_line.payout_method = 'accrual' and v_line.status = 'done' then
      -- Mesmo lock de create_payout: um repasse em curso e este estorno se enfileiram.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('payout:' || v_line.beneficiary_id::text, 0));
      select * into v_accrual from public.bureau_payable_entries e
       where e.pix_charge_id = p_charge_id and e.bureau_id = v_line.beneficiary_id and e.kind = 'accrual';
      if found then
        v_entry_id := null;
        insert into public.bureau_payable_entries (bureau_id, kind, amount, pix_charge_id, reverses_entry_id)
        values (v_line.beneficiary_id, 'reversal', -v_accrual.amount, p_charge_id, v_accrual.id)
        on conflict (reverses_entry_id) where reverses_entry_id is not null do nothing
        returning id into v_entry_id;
        if v_entry_id is not null then
          insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
          values (v_line.beneficiary_id, null, 'payable.cash_in_reversal', 'bureau_payable_entries', v_entry_id,
            jsonb_build_object('pix_charge_id', p_charge_id, 'kind', v_line.beneficiary_kind,
              'amount', (-v_accrual.amount)::text, 'event', p_event_type));
        end if;
      end if;
      v_new := 'refunded';

    elsif v_line.payout_method = 'pix' and v_line.status = 'done' then
      -- Ordem de travas: carteira do afiliado -> comissão (a mesma de release_due_commissions).
      perform 1 from public.affiliate_wallets w where w.profile_id = v_line.beneficiary_id for update;
      select * into v_commission from public.affiliate_commissions c where c.order_ref = p_charge_id for update;
      if found then
        v_remaining := v_commission.amount - v_commission.reversed_amount;
        if v_remaining > 0 then
          select * into v_post from public.affiliate_wallet_post_entry(
            v_commission.affiliate_profile_id,
            case when v_commission.status = 'pending' then 'commission_reversal' else 'commission_clawback' end,
            v_remaining, 'cashin:reversal:' || p_charge_id::text, 'commission:' || v_commission.id::text,
            v_commission.affiliate_profile_id, 'cash_in');
          if not v_post.ok then
            raise exception 'affiliate cash-in reversal failed: %', v_post.reason;
          end if;
          update public.affiliate_commissions set reversed_amount = amount, status = 'reversed'
           where id = v_commission.id;
          insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
          values (v_commission.bureau_id, null, 'affiliate.commission_reversal', 'affiliate_commissions',
            v_commission.id,
            jsonb_build_object('origin', 'cash_in', 'pix_charge_id', p_charge_id, 'amount', v_remaining::text,
              'available_after', v_post.available::text, 'event', p_event_type));
        end if;
      end if;
      v_new := 'refunded';

    elsif v_line.payout_method = 'asaas' and v_line.status = 'refused' then
      -- Nada saiu para o beneficiário e a cobrança voltou: não há o que pagar por fora.
      v_new := 'refunded';

    elsif v_line.payout_method = 'asaas' and v_items is not null then
      -- Parcela 2..n do cartão tem outro id de split: casa pelo walletId.
      select i into v_item from jsonb_array_elements(v_items) i
       where jsonb_typeof(i) = 'object'
         and (i ->> 'id' = v_line.asaas_split_id
           or ((v_line.asaas_split_id is null or v_charge.installments > 1) and i ->> 'walletId' = v_line.asaas_wallet_id))
       order by (i ->> 'id' = v_line.asaas_split_id) desc nulls last
       limit 1;
      -- DONE no pedido de chargeback não é falha: o Asaas reverte depois (a linha espera o REFUNDED ou CANCELLED).
      v_new := case
        when upper(v_item ->> 'status') in ('REFUNDED', 'CANCELLED') then 'refunded'
        when upper(v_item ->> 'status') = 'DONE' and p_event_type <> 'PAYMENT_CHARGEBACK_REQUESTED' then 'reversal_failed'
      end;
    end if;

    if v_new is not null then
      update public.charge_splits set status = v_new where id = v_line.id;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (
        case when v_line.beneficiary_kind = 'partner' then null else v_line.bureau_id end,
        null, 'charge_split.' || v_new, 'charge_splits', v_line.id,
        jsonb_build_object(
          'pix_charge_id', p_charge_id,
          'beneficiary_kind', v_line.beneficiary_kind,
          'payout_method', v_line.payout_method,
          'from_status', v_line.status,
          'event', p_event_type,
          'wallet', case when v_line.asaas_wallet_id is null then null else '***' || right(v_line.asaas_wallet_id, 4) end));
      v_done := v_done + 1;
    end if;
  end loop;
  return v_done;
end
$$;
