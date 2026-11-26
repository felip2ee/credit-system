-- Estorno do PIX de pedido com vários pedidos do mesmo cliente (revisão de dinheiro, P2-1). A 001-066 já foram aplicadas e
-- não mudam.
-- Antes (066): o estorno só olhava o pedido do PIX com order_reservation_left, que desconta primeiro as reservas mais novas.
-- O que o estorno tirava do reservado caía no pedido mais ANTIGO: o pedido pago com saldo ficava sem lastro, o do PIX
-- estornado seguia vivo, e o tick executava (custo) uma consulta que a captura depois recusava (reservation_clawed_back).
-- Agora a conta é da carteira do cliente. Demanda = soma dos preços das liquidações 'reserved' do cliente (pedidos
-- cancelláveis e em execução). Lastro = wallets.reserved, já com o estorno. Demanda <= lastro: nada cancela. Demanda >
-- lastro: cancela, enquanto faltar lastro, primeiro o pedido do PIX estornado (se ainda não executa) e depois os outros
-- pedidos awaiting_authorization/ready, do mais novo (maior seq) para o mais antigo. Pedido executing/concluído nunca é
-- cancelado: continua no clawback da captura (capture_order).
-- Cada cancelamento devolve ao disponível só o que sobra do lastro depois de cobrir os demais pedidos vivos:
-- least(preço, greatest(0, lastro - (demanda - preço))). Nunca devolve em dobro, nunca deixa o reservado abaixo do que os
-- outros pedidos precisam. release_order não serve aqui: desconta as reservas mais novas primeiro e devolveria o lastro
-- dos pedidos que devem seguir. A liberação usa a mesma chave de idempotência 'order:release:<pedido>' e a mesma
-- liberação do cupom (coupon_release_redemption).
-- Ordem de travas (P2-2): pedido -> liquidação -> carteira, em toda parte. apply_asaas_payment trava, antes da carteira,
-- todos os pedidos e liquidações 'reserved' do cliente (ordenados por id: dois estornos do mesmo cliente se enfileiram
-- sem se cruzar). cancel_order_after_pix_refund só pega, sem esperar (skip locked), um pedido que surgiu depois dessa
-- trava: nunca espera por trava fora de ordem. completeOrder/failOrder (TS) passam a travar o pedido primeiro.
-- Dono, search_path e grants não mudam (create or replace).

create or replace function cancel_order_after_pix_refund(p_charge_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_cand record;
  v_post record;
  v_demand numeric;
  v_backing numeric;
  v_release numeric;
  v_holder uuid;
  v_cancelled boolean := false;
  v_prev_user text := coalesce(current_setting('app.user_id', true), '');
  v_prev_role text := coalesce(current_setting('app.user_role', true), '');
  v_prev_bureau text := coalesce(current_setting('app.bureau_id', true), '');
  v_prev_support text := coalesce(current_setting('app.support_session_id', true), '');
begin
  select * into v_charge from public.pix_charges
   where id = p_charge_id and order_id is not null and status = 'refunded' and client_profile_id is not null;
  if v_charge.id is null then
    return false;
  end if;
  -- Carteira do cliente (apply_asaas_payment já a travou e debitou): o lastro que sobrou depois do estorno.
  select reserved into strict v_backing from public.client_wallets
   where client_profile_id = v_charge.client_profile_id for update;
  select coalesce(sum(s.price), 0) into v_demand from public.order_settlements s
   where s.client_profile_id = v_charge.client_profile_id and s.mode = 'online' and s.status = 'reserved';
  if v_demand <= v_backing then
    return false;
  end if;

  -- release e as políticas do cancelamento só agem com o contexto do cliente dono do pedido (como em
  -- apply_order_pix_charge). Contexto local da transação, restaurado abaixo.
  perform set_config('app.user_id', v_charge.client_profile_id::text, true);
  perform set_config('app.user_role', 'client', true);
  perform set_config('app.bureau_id', v_charge.bureau_id::text, true);
  perform set_config('app.support_session_id', '', true);

  for v_cand in
    select o.dossier_id, s.id as settlement_id, s.price, s.order_ref
      from public.dossier_orders o
      join public.order_settlements s on s.order_ref = o.dossier_id
     where s.client_profile_id = v_charge.client_profile_id and s.mode = 'online' and s.status = 'reserved'
       and o.mode = 'online' and o.state in ('awaiting_authorization', 'ready')
     order by (o.dossier_id = v_charge.order_id) desc, s.seq desc
       for update of o, s skip locked
  loop
    exit when v_demand <= v_backing;
    v_demand := v_demand - v_cand.price;
    -- O que sobra do lastro depois de cobrir os pedidos que seguem vivos volta ao disponível.
    v_release := least(v_cand.price, greatest(0, v_backing - v_demand));
    if v_release > 0 then
      select * into v_post from public.client_wallet_post_entry(
        v_charge.client_profile_id, 'release', v_release, 'order:release:' || v_cand.order_ref::text,
        'order:' || v_cand.order_ref::text, null, v_charge.client_profile_id);
      if not v_post.ok then
        raise exception 'cancel_order_after_pix_refund: release failed (%)', v_post.reason;
      end if;
      v_backing := v_backing - v_release;
    end if;
    perform public.coupon_release_redemption(v_cand.order_ref, v_charge.client_profile_id);
    update public.order_settlements set status = 'released', closed_at = now() where id = v_cand.settlement_id;

    -- O mesmo que cancel_client_order faz (estado, dossiê, consultas, autorizações, trilha), com o motivo payment_refunded.
    update public.dossier_orders
       set state = 'cancelled', state_reason = 'payment_refunded', lease_until = null, updated_at = now()
     where dossier_id = v_cand.dossier_id;
    update public.dossiers set status = 'cancelled'
     where id = v_cand.dossier_id and bureau_id = v_charge.bureau_id;
    update public.consultations set status = 'rejected'
     where dossier_id = v_cand.dossier_id and bureau_id = v_charge.bureau_id
       and status in ('pending_authorization', 'processing');
    -- Links já enviados deixam de valer: autorização pendente que nenhuma outra consulta viva usa passa a 'expired'.
    update public.scr_authorizations a
       set status = 'expired'::public.scr_status, auth_code = null, last_checked_at = now()
     where a.bureau_id = v_charge.bureau_id and a.status = 'pending'
       and a.id in (select c.scr_authorization_id from public.consultations c where c.dossier_id = v_cand.dossier_id)
       and not exists (select 1 from public.consultations c2
                        where c2.scr_authorization_id = a.id and c2.dossier_id <> v_cand.dossier_id
                          and c2.status in ('pending_authorization', 'authorized', 'processing'));

    select d.holder_id into v_holder from public.dossiers d where d.id = v_cand.dossier_id;
    if v_holder is not null then
      insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata, created_by)
      values (v_charge.bureau_id, 'holder', v_holder, 'order.cancelled', 'Pedido de pesquisa cancelado',
              jsonb_build_object('dossier_id', v_cand.dossier_id), v_charge.client_profile_id);
    end if;
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (v_charge.bureau_id, v_charge.client_profile_id, 'order.cancel', 'dossier_orders', v_cand.dossier_id,
            jsonb_build_object('reason', 'payment_refunded', 'source', 'asaas_webhook', 'pix_charge_id', v_charge.id,
                               'refunded_order_id', v_charge.order_id, 'released', v_release::text));
    v_cancelled := true;
  end loop;

  perform set_config('app.user_id', v_prev_user, true);
  perform set_config('app.user_role', v_prev_role, true);
  perform set_config('app.bureau_id', v_prev_bureau, true);
  perform set_config('app.support_session_id', v_prev_support, true);
  return v_cancelled;
end
$$;

alter function cancel_order_after_pix_refund(uuid) owner to auth_profile_lookup;
revoke all on function cancel_order_after_pix_refund(uuid) from public;

-- apply_asaas_payment (066): corpo igual, menos o bloco que trava o pedido e a liquidação do estorno (abaixo). Dono e
-- grants (app_webhook) ficam (create or replace).
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
      -- PIX de pedido: trava o pedido do PIX e todos os pedidos com liquidação 'reserved' do cliente (o estorno pode
      -- cancelar qualquer um deles, 067), e depois as liquidações, antes da carteira. É a ordem global pedido ->
      -- liquidação -> carteira de cancel_client_order, capture_order e do fechamento do tick. Em cada grupo a ordem é por
      -- id: dois estornos do mesmo cliente se enfileiram sem se cruzar.
      if v_charge.order_id is not null then
        perform 1 from public.dossier_orders o
         where o.dossier_id = v_charge.order_id
            or o.dossier_id in (select s.order_ref from public.order_settlements s
                                 where s.client_profile_id = v_charge.client_profile_id
                                   and s.mode = 'online' and s.status = 'reserved')
         order by o.dossier_id for update;
        perform 1 from public.order_settlements s
         where s.order_ref = v_charge.order_id
            or (s.client_profile_id = v_charge.client_profile_id and s.mode = 'online' and s.status = 'reserved')
         order by s.order_ref for update;
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
