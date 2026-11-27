-- Estorno do PIX do pedido antes da captura (revisão final de dinheiro, P2). A 001-065 já foram aplicadas e não mudam.
-- Antes: PAYMENT_REFUNDED tirava o valor do reservado, mas a liquidação ficava 'reserved' e o pedido 'ready'; o tick
-- executava o DEPS (custo da plataforma e do Bureau) e só a captura devolvia reservation_clawed_back.
-- Agora, no ramo de estorno de apply_asaas_payment, a cobrança com order_id cujo pedido ainda não executa
-- (awaiting_authorization ou ready) e cuja reserva o estorno deixou incompleta (order_reservation_left < preço, a mesma
-- regra de capture_order) libera a liquidação e cancela o pedido na mesma transação, com state_reason 'payment_refunded'.
-- release_order devolve só o que sobrou da reserva (o estorno já retirou o resto): não há devolução em dobro nem saldo
-- negativo. Estorno coberto por outro saldo do cliente (a reserva está inteira) não cancela. Pedido executing/concluído
-- mantém o clawback na captura. Reenvio do evento ou outro evento da mesma cobrança já cai em 'duplicate' antes daqui.
-- Ordem de travas do ramo de estorno de pedido: cobrança -> pedido -> liquidação -> carteira do cliente.
alter table dossier_orders drop constraint dossier_orders_state_reason_check;
alter table dossier_orders add constraint dossier_orders_state_reason_check
  check (state_reason is null or state_reason in ('scr_refused', 'scr_expired', 'payment_timeout',
    'cancelled_by_staff', 'cancelled_by_client', 'deps_no_data', 'deps_incompatible', 'deps_unavailable',
    'reservation_clawed_back', 'payment_not_reserved', 'payment_refunded'));

-- Chamada só por apply_asaas_payment, com a cobrança já estornada e a carteira do cliente travada e debitada.
-- Devolve true se cancelou o pedido. Repete o que cancel_client_order faz (estado, dossiê, consultas, autorizações,
-- trilha) com o motivo payment_refunded. Falha na liberação aborta a transação: o pedido nunca fecha com a reserva presa.
create function cancel_order_after_pix_refund(p_charge_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_order public.dossier_orders;
  v_s public.order_settlements;
  v_wallet_reserved numeric;
  v_release record;
  v_holder uuid;
  v_prev_user text := coalesce(current_setting('app.user_id', true), '');
  v_prev_role text := coalesce(current_setting('app.user_role', true), '');
  v_prev_bureau text := coalesce(current_setting('app.bureau_id', true), '');
  v_prev_support text := coalesce(current_setting('app.support_session_id', true), '');
begin
  select * into v_charge from public.pix_charges
   where id = p_charge_id and order_id is not null and status = 'refunded';
  if v_charge.id is null then
    return false;
  end if;
  select * into v_order from public.dossier_orders where dossier_id = v_charge.order_id for update;
  if not found or v_order.mode <> 'online' or v_order.state not in ('awaiting_authorization', 'ready') then
    return false;
  end if;
  select * into v_s from public.order_settlements where order_ref = v_charge.order_id for update;
  if not found or v_s.mode <> 'online' or v_s.status <> 'reserved' then
    return false;
  end if;
  -- A reserva que o estorno deixou ao pedido (a mesma conta de capture_order): inteira, o pedido segue pago.
  select reserved into strict v_wallet_reserved from public.client_wallets
   where client_profile_id = v_s.client_profile_id for update;
  if public.order_reservation_left(v_s.order_ref, v_wallet_reserved) >= v_s.price then
    return false;
  end if;

  -- release_order e as políticas do cancelamento só agem com o contexto do cliente dono do pedido (como em
  -- apply_order_pix_charge). Contexto local da transação, restaurado abaixo.
  perform set_config('app.user_id', v_charge.client_profile_id::text, true);
  perform set_config('app.user_role', 'client', true);
  perform set_config('app.bureau_id', v_charge.bureau_id::text, true);
  perform set_config('app.support_session_id', '', true);

  select * into v_release from public.release_order(v_charge.order_id);
  if not v_release.ok then
    raise exception 'cancel_order_after_pix_refund: release failed (%)', v_release.reason;
  end if;

  update public.dossier_orders
     set state = 'cancelled', state_reason = 'payment_refunded', lease_until = null, updated_at = now()
   where dossier_id = v_charge.order_id;
  update public.dossiers set status = 'cancelled'
   where id = v_charge.order_id and bureau_id = v_charge.bureau_id;
  update public.consultations set status = 'rejected'
   where dossier_id = v_charge.order_id and bureau_id = v_charge.bureau_id
     and status in ('pending_authorization', 'processing');
  -- Links já enviados deixam de valer: autorização pendente que nenhuma outra consulta viva usa passa a 'expired'.
  update public.scr_authorizations s
     set status = 'expired'::public.scr_status, auth_code = null, last_checked_at = now()
   where s.bureau_id = v_charge.bureau_id and s.status = 'pending'
     and s.id in (select c.scr_authorization_id from public.consultations c where c.dossier_id = v_charge.order_id)
     and not exists (select 1 from public.consultations c2
                      where c2.scr_authorization_id = s.id and c2.dossier_id <> v_charge.order_id
                        and c2.status in ('pending_authorization', 'authorized', 'processing'));

  select d.holder_id into v_holder from public.dossiers d where d.id = v_charge.order_id;
  if v_holder is not null then
    insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata, created_by)
    values (v_charge.bureau_id, 'holder', v_holder, 'order.cancelled', 'Pedido de pesquisa cancelado',
            jsonb_build_object('dossier_id', v_charge.order_id), v_charge.client_profile_id);
  end if;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.client_profile_id, 'order.cancel', 'dossier_orders', v_charge.order_id,
          jsonb_build_object('reason', 'payment_refunded', 'source', 'asaas_webhook', 'pix_charge_id', v_charge.id));

  perform set_config('app.user_id', v_prev_user, true);
  perform set_config('app.user_role', v_prev_role, true);
  perform set_config('app.bureau_id', v_prev_bureau, true);
  perform set_config('app.support_session_id', v_prev_support, true);
  return true;
end
$$;

alter function cancel_order_after_pix_refund(uuid) owner to auth_profile_lookup;
revoke all on function cancel_order_after_pix_refund(uuid) from public;

-- apply_asaas_payment (065): corpo igual, mais o cancelamento do pedido no ramo de estorno. Dono e grants (app_webhook)
-- ficam (create or replace).
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
  v_reserved numeric;
  v_reversed numeric;
  v_shortfall numeric;
  v_payable numeric;
  v_clawback numeric := 0;
  v_left numeric;
  v_affiliate uuid;
  v_commission record;
  v_commission_reversal numeric;
  v_commissions_reversed numeric := 0;
  v_audit_table text;
  v_audit_record uuid;
  v_ref text;
  v_installment text;
  v_paid numeric;
  v_expected numeric;
  v_tolerance numeric;
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

  -- Parcelamento no cartão: cada parcela tem um id de pagamento, mas todas levam o mesmo payment.installment. A
  -- cobrança é a do parcelamento, não a da parcela.
  v_installment := nullif(btrim(p_payload -> 'payment' ->> 'installment'), '');
  if v_charge.id is null and v_installment is not null then
    select * into v_charge from public.pix_charges where asaas_installment_id = v_installment;
  end if;

  -- Reserva: o bind do id do pagamento falhou (ou ainda não rodou). A cobrança é achada por payment.externalReference.
  -- Pix: só a sem id, que ganha o id do pagamento. Cartão: também a que já tem id de outra parcela; o id só entra se
  -- faltar, e o id do parcelamento entra se faltar. O valor creditado continua sendo pix_charges.amount.
  if v_charge.id is null then
    v_ref := p_payload -> 'payment' ->> 'externalReference';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_charge from public.pix_charges
       where external_reference = v_ref::uuid
         and (asaas_payment_id is null or billing_type = 'CREDIT_CARD')
         for update;
      if v_charge.id is not null then
        update public.pix_charges
           set asaas_payment_id = coalesce(asaas_payment_id, p_asaas_payment_id),
               asaas_installment_id = case when billing_type = 'CREDIT_CARD'
                 then coalesce(asaas_installment_id, v_installment) else asaas_installment_id end
         where id = v_charge.id;
      end if;
    end if;
  end if;

  -- Cobrança desconhecida: guarda só o registro do evento, sem o corpo (evita inchar a tabela).
  insert into public.asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
  values (v_charge.bureau_id, p_event_id, p_event_type, p_asaas_payment_id,
    case when v_charge.id is null then null else coalesce(p_payload, '{}'::jsonb) end, 'received')
  on conflict (event_id) do nothing
  returning id into v_event_row;
  if v_event_row is null then
    -- Reenvio: a cobrança de link de pagamento não passa pelo reparo de nota (NFS-e) do webhook.
    return case when v_charge.payment_link_id is not null then 'link_duplicate' else 'duplicate' end;
  end if;

  if v_charge.id is null then
    v_result := 'unknown_charge';
  elsif v_charge.payment_link_id is not null then
    -- Cobrança de link de pagamento: nunca toca carteira, comissão ou repasse. Só o pedido de balcão.
    v_result := public.apply_payment_link_charge(v_charge.id, p_event_type, p_payload);
  elsif v_charge.order_id is not null and p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    -- PIX de pedido online (063): credita e reserva. Estorno e chargeback seguem o ramo do cliente abaixo.
    v_result := public.apply_order_pix_charge(v_charge.id, p_payload);
  elsif p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status in ('paid', 'refunded') then
      v_result := 'duplicate';
    elsif v_charge.status = 'cancelled' then
      v_result := 'ignored';
    else
      -- Valor pago (payment.value) contra o esperado. Abaixo do esperado, além da tolerância: não credita. Igual ou
      -- acima credita o valor da linha (juros e multa nunca travam um pagamento real). Sem valor numérico: credita.
      -- Pix: total_charged (recarga + taxa do Pix repassada), ou amount quando a linha não tem total (sem taxa, e as
      -- linhas anteriores à 045). Cartão: total cobrado dividido pelas parcelas, com tolerância de n centavos (o resto vai
      -- na última). O que se credita (e estorna) é sempre amount, nunca o total.
      v_paid := case when (p_payload -> 'payment' ->> 'value') ~ '^-?\d+(\.\d+)?$'
        then (p_payload -> 'payment' ->> 'value')::numeric end;
      if v_charge.billing_type = 'CREDIT_CARD' then
        v_expected := coalesce(v_charge.total_charged, v_charge.amount) / v_charge.installments;
        v_tolerance := v_charge.installments * 0.01;
      else
        v_expected := coalesce(v_charge.total_charged, v_charge.amount);
        v_tolerance := 0;
      end if;
      if v_paid is not null and v_paid < v_expected - v_tolerance then
        v_result := 'amount_mismatch';
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
    end if;
  elsif p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status = 'refunded' then
      v_result := 'duplicate';
    elsif v_charge.status = 'pending' then
      -- Estorno antes do pagamento (eventos fora de ordem): não há dinheiro a tirar. A cobrança vira refunded para
      -- que um PAYMENT_RECEIVED tardio caia em 'duplicate' e não credite o PIX estornado.
      update public.pix_charges set status = 'refunded' where id = v_charge.id;
      v_result := 'ignored';
    elsif v_charge.status <> 'paid' then
      v_result := 'ignored';
    else
      -- PIX de pedido: trava o pedido e a liquidação antes da carteira (a ordem de cancel_client_order e de
      -- capture_order: pedido -> liquidação -> carteira). Evita o impasse com um cancelamento que corre junto.
      if v_charge.order_id is not null then
        perform 1 from public.dossier_orders where dossier_id = v_charge.order_id for update;
        perform 1 from public.order_settlements where order_ref = v_charge.order_id for update;
      end if;
      -- Trava a carteira antes de ler o saldo: o estorno tira o disponível e, no que faltar, o reservado.
      if v_charge.client_profile_id is null then
        select available, reserved into strict v_available, v_reserved
          from public.wallets where bureau_id = v_charge.bureau_id for update;
      else
        select available, reserved into strict v_available, v_reserved
          from public.client_wallets where client_profile_id = v_charge.client_profile_id for update;
      end if;
      v_reversed := least(v_available + v_reserved, v_charge.amount);
      v_shortfall := v_charge.amount - v_reversed;
      -- Cobrança do cliente: o que a carteira não cobre pode já ter virado comissão do afiliado e valor a repassar ao
      -- Bureau (pedido capturado depois da recarga). A falta paga primeiro com a comissão ainda pendente do indicado
      -- (a mais nova primeiro) e só o resto é cobrado do Bureau. Comissão liberada não é tocada: o afiliado já pode
      -- sacar. O que sobra continua em refund_shortfall (o M6 cobre).
      v_left := v_shortfall;
      if v_charge.client_profile_id is not null and v_left > 0 then
        -- Ordem de travas: carteira do cliente (acima) -> carteira do afiliado -> comissões. As comissões pendentes de
        -- um indicado são de um afiliado só (o vínculo é imutável), então a carteira dele vem antes. release_due_commissions
        -- segue a mesma ordem; por isso as duas rotinas não se cruzam.
        select r.affiliate_profile_id into v_affiliate
          from public.affiliate_referrals r where r.referred_profile_id = v_charge.client_profile_id;
        if v_affiliate is not null then
          perform 1 from public.affiliate_wallets w where w.profile_id = v_affiliate for update;
          for v_commission in
            select c.id, c.amount, c.reversed_amount, c.bureau_id, c.affiliate_profile_id
              from public.affiliate_commissions c
             where c.referred_profile_id = v_charge.client_profile_id and c.status = 'pending'
             order by c.created_at desc, c.id desc
               for update
          loop
            exit when v_left <= 0;
            v_commission_reversal := least(v_commission.amount - v_commission.reversed_amount, v_left);
            -- O livro do afiliado não guarda a cobrança nem o comprador: a referência é a comissão.
            select * into v_post from public.affiliate_wallet_post_entry(
              v_commission.affiliate_profile_id,
              'commission_reversal', v_commission_reversal,
              'refund:' || v_commission.id::text || ':' || md5(v_charge.id::text),
              'commission:' || v_commission.id::text, v_commission.affiliate_profile_id);
            if not v_post.ok then
              raise exception 'affiliate commission reversal failed: %', v_post.reason;
            end if;
            update public.affiliate_commissions
               set reversed_amount = reversed_amount + v_commission_reversal,
                   status = case when reversed_amount + v_commission_reversal = amount then 'reversed' else status end
             where id = v_commission.id;
            insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
            values (v_commission.bureau_id, v_charge.requested_by, 'affiliate.commission_reversal',
              'affiliate_commissions', v_commission.id,
              jsonb_build_object('pix_charge_id', v_charge.id, 'amount', v_commission_reversal::text));
            v_left := v_left - v_commission_reversal;
            v_commissions_reversed := v_commissions_reversed + v_commission_reversal;
          end loop;
        end if;
      end if;
      -- O que a comissão não cobriu vira clawback do Bureau, até o saldo a repassar ainda não pago. O lock é o de
      -- create_payout: um repasse em curso e este estorno se enfileiram.
      if v_charge.client_profile_id is not null and v_left > 0 then
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('payout:' || v_charge.bureau_id::text, 0));
        -- Só o que nenhum repasse pegou (o mesmo conjunto de create_payout): o valor de um repasse aberto não
        -- sofre estorno, porque o lançamento "payout" (−) só nasce ao marcar como pago.
        select coalesce(sum(e.amount), 0) into v_payable
          from public.bureau_payable_entries e
         where e.bureau_id = v_charge.bureau_id
           and e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
           and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
        v_clawback := least(v_left, greatest(v_payable, 0));
        v_left := v_left - v_clawback;
      end if;
      update public.pix_charges
         set status = 'refunded', refund_shortfall = v_left where id = v_charge.id;
      if v_clawback > 0 then
        insert into public.bureau_payable_entries (bureau_id, kind, amount, pix_charge_id)
        values (v_charge.bureau_id, 'reversal', -v_clawback, v_charge.id);
      end if;
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
          'amount', v_reversed::text, 'shortfall', v_shortfall::text, 'payable_reversal', v_clawback::text,
          'commission_reversal', v_commissions_reversed::text, 'event', p_event_type));
      -- PIX de pedido estornado antes de o pedido executar: o pedido deixa de ter dinheiro e é cancelado agora (066).
      if v_charge.order_id is not null then
        perform public.cancel_order_after_pix_refund(v_charge.id);
      end if;
      v_result := 'refunded';
    end if;
  elsif p_event_type = 'PAYMENT_PARTIALLY_REFUNDED' then
    -- Estorno parcial: o M6 decide como tratar o dinheiro. Aqui nenhum saldo muda; o evento fica gravado (com o corpo)
    -- sob este resultado, que a operação enxerga.
    v_result := 'partial_refund_ignored';
  elsif p_event_type in ('PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    -- Disputa em andamento ou chargeback revertido: nenhum saldo muda aqui; a operação decide. O resultado próprio
    -- tira o evento do 'ignored' silencioso (a rota registra no log).
    v_result := 'chargeback_ignored';
  else
    v_result := 'ignored';
  end if;

  update public.asaas_webhook_events set result = v_result where id = v_event_row;
  return v_result;
end
$$;
