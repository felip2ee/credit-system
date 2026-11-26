-- Pagamento por pedido, parte 2 (webhook). A 001-064 já foram aplicadas e não mudam. O plano previa o número 064; a 064
-- virou o gatilho order_settlements_refresh_online, por isso este arquivo é a 065.
-- Baixa do PIX de pedido online (063). Chamada só por apply_asaas_payment, já com o evento gravado. Numa transação:
-- confere o valor, marca a cobrança paga, credita o preço na carteira do cliente e, com o pedido aguardando pagamento,
-- reserva o pedido com o preço e o cupom guardados e atualiza o estado. Reserva recusada: o preço fica como saldo e o
-- tick cancela o pedido (payment_not_reserved). Estorno não passa aqui: segue o ramo do cliente de apply_asaas_payment.
-- Ordem de travas: cobrança -> pedido -> cupom (advisory, a mesma de reserve_order) -> carteira do cliente ->
-- (reserve_order: liquidação -> carteira do cliente -> repasse -> carteira do Bureau).
alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch',
    'link_paid', 'link_duplicate', 'link_ignored', 'link_order_not_payable', 'link_refund_ignored',
    'link_overpaid', 'order_paid', 'order_reserve_failed', 'order_not_payable'));

-- Auditoria do ramo do pedido: só o dono das funções, só estas ações, só junto da cobrança paga ou da liquidação nova.
create policy audit_logs_order_pix_insert on audit_logs for insert to auth_profile_lookup with check (
  support_session_id is null and bureau_id is not null and (
    (action = 'order.pix_paid' and table_name = 'pix_charges' and exists (
       select 1 from pix_charges c
        where c.id = audit_logs.record_id and c.order_id is not null and c.status = 'paid'
          and c.bureau_id = audit_logs.bureau_id and c.requested_by = audit_logs.user_id))
    or (action = 'settlement.reserve' and table_name = 'order_settlements' and exists (
       select 1 from order_settlements s
        where s.id = audit_logs.record_id and s.mode = 'online' and s.bureau_id = audit_logs.bureau_id
          and s.client_profile_id = audit_logs.user_id and s.created_at = now()))));

create function apply_order_pix_charge(p_charge_id uuid, p_payload jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_order public.dossier_orders;
  v_quote public.order_pix_quotes;
  v_paid numeric;
  v_post record;
  v_res record;
  v_coupon uuid;
  v_slot uuid;
  v_settlement uuid;
  v_reason text;
  v_result text;
  v_prev_user text := coalesce(current_setting('app.user_id', true), '');
  v_prev_role text := coalesce(current_setting('app.user_role', true), '');
  v_prev_bureau text := coalesce(current_setting('app.bureau_id', true), '');
  v_prev_support text := coalesce(current_setting('app.support_session_id', true), '');
  v_prev_slot text := coalesce(current_setting('app.coupon_slot', true), '');
begin
  select * into v_charge from public.pix_charges where id = p_charge_id and order_id is not null for update;
  if v_charge.id is null or v_charge.status = 'cancelled' then
    return 'ignored';
  end if;
  if v_charge.status in ('paid', 'refunded') then
    return 'duplicate';
  end if;
  -- Regra da recarga (045/050): abaixo do total esperado não credita; sem valor numérico ou acima credita amount.
  v_paid := case when (p_payload -> 'payment' ->> 'value') ~ '^-?\d+(\.\d+)?$'
    then (p_payload -> 'payment' ->> 'value')::numeric end;
  if v_paid is not null and v_paid < coalesce(v_charge.total_charged, v_charge.amount) then
    return 'amount_mismatch';
  end if;

  select * into strict v_order from public.dossier_orders where dossier_id = v_charge.order_id for update;
  select * into strict v_quote from public.order_pix_quotes where dossier_id = v_charge.order_id;
  if v_quote.coupon_code is not null then
    select c.id into v_coupon from public.coupons c
     where c.bureau_id = v_charge.bureau_id and c.code = upper(btrim(v_quote.coupon_code));
    if v_coupon is not null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coupon:' || v_coupon::text, 0));
    end if;
  end if;

  update public.pix_charges set status = 'paid' where id = v_charge.id;
  select * into v_post from public.client_wallet_post_entry(
    v_charge.client_profile_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
    'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
  if not v_post.ok then
    raise exception 'wallet topup failed: %', v_post.reason;
  end if;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', 'client_ledger_entries', v_post.entry_id,
    jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id, 'order_id', v_charge.order_id,
      'amount', v_charge.amount::text));

  if v_order.mode <> 'online' or v_order.state <> 'awaiting_payment' or v_quote.price <> v_charge.amount then
    v_result := 'order_not_payable';
  else
    -- reserve_order só age com o contexto do cliente dono do pedido (055). Contexto local da transação, restaurado abaixo.
    perform set_config('app.user_id', v_charge.client_profile_id::text, true);
    perform set_config('app.user_role', 'client', true);
    perform set_config('app.bureau_id', v_charge.bureau_id::text, true);
    perform set_config('app.support_session_id', '', true);
    if v_quote.coupon_code is not null then
      -- O código foi conferido (e a tentativa contada) na abertura. A vaga evita que o limite por hora recuse o cupom já pago.
      insert into public.coupon_attempt_misses (profile_id, bureau_id)
      values (v_charge.client_profile_id, v_charge.bureau_id) returning id into v_slot;
      perform set_config('app.coupon_slot', v_slot::text, true);
    end if;
    select * into v_res from public.reserve_order(v_charge.order_id, 'online', v_charge.client_profile_id,
      v_quote.price, 0, '{"lines": []}'::jsonb, v_quote.coupon_code);
    if v_slot is not null then
      delete from public.coupon_attempt_misses where id = v_slot;
    end if;
    if v_res.ok then
      select s.id into v_settlement from public.order_settlements s where s.order_ref = v_charge.order_id;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.client_profile_id, 'settlement.reserve', 'order_settlements', v_settlement,
        jsonb_build_object('order_ref', v_charge.order_id, 'mode', 'online', 'status', 'reserved',
          'price', v_quote.price::text, 'source', 'asaas_webhook'));
      perform public.refresh_order_state(v_charge.order_id);
      v_result := 'order_paid';
    else
      v_reason := v_res.reason;
      v_result := 'order_reserve_failed';
    end if;
    perform set_config('app.user_id', v_prev_user, true);
    perform set_config('app.user_role', v_prev_role, true);
    perform set_config('app.bureau_id', v_prev_bureau, true);
    perform set_config('app.support_session_id', v_prev_support, true);
    perform set_config('app.coupon_slot', v_prev_slot, true);
  end if;

  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'order.pix_paid', 'pix_charges', v_charge.id,
    jsonb_build_object('order_id', v_charge.order_id, 'amount', v_charge.amount::text, 'result', v_result)
      || case when v_reason is not null then jsonb_build_object('reason', v_reason) else '{}'::jsonb end);
  return v_result;
end
$$;

alter function apply_order_pix_charge(uuid, jsonb) owner to auth_profile_lookup;
revoke all on function apply_order_pix_charge(uuid, jsonb) from public;

-- apply_asaas_payment (058): corpo igual, mais o ramo do PIX de pedido. Dono e grants (app_webhook) ficam (create or replace).
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
