-- Pix de link e pagamento de balcão ao mesmo tempo (segunda revisão de segurança da 060). Corpo igual ao da 060, salvo o que segue.
-- M-A) Pix de valor igual ao da cobrança, com o pedido aguardando pagamento: SEMPRE vira pagamento de balcão (o dinheiro
--      recebido nunca fica sem lançamento) e refresh_order_state decide se o pedido avança. Pagamento de balcão que entrou
--      depois da reserva deixou de dar amount_mismatch. O link só vira 'paid' quando o pedido saiu de awaiting_payment ou
--      a soma lançada cobre o preço; senão fica ativo, para a próxima abertura cobrar o que falta. Soma acima do preço:
--      resultado novo link_overpaid (lançado igual; a operação devolve a diferença). amount_mismatch só para valor pago
--      diferente do valor da cobrança.
-- L-B) Estorno ou chargeback antes do RECEIVED também cobre cobrança expired ou cancelled (a reserva troca a cobrança
--      pendente por expired/cancelled): um RECEIVED tardio cai em link_duplicate e não baixa o pedido.
-- Lock: cobrança, depois pedido (o código de balcão trava só o pedido, antes de inserir ou anular).

alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch',
    'link_paid', 'link_duplicate', 'link_ignored', 'link_order_not_payable', 'link_refund_ignored',
    'link_overpaid'));

create or replace function apply_payment_link_charge(p_charge_id uuid, p_event_type text, p_payload jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_link public.payment_links;
  v_state text;
  v_after text;
  v_price numeric;
  v_paid numeric;
  v_sum numeric;
begin
  if p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
                      'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    -- Estorno de Pix de link: o pedido já pode ter avançado. A operação decide; o resultado próprio tira o evento do
    -- silêncio. Antes do pagamento (eventos fora de ordem) a cobrança vira refunded, como na 050: um RECEIVED tardio
    -- cai em link_duplicate e não baixa o pedido. Vale também para cobrança já trocada (expired, cancelled).
    if p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
      update public.pix_charges set status = 'refunded'
       where id = p_charge_id and payment_link_id is not null and status in ('pending', 'expired', 'cancelled');
    end if;
    return 'link_refund_ignored';
  end if;
  if p_event_type not in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    return 'link_ignored';
  end if;
  select * into v_charge from public.pix_charges where id = p_charge_id and payment_link_id is not null for update;
  if v_charge.id is null then
    return 'link_ignored';
  end if;
  if v_charge.status in ('paid', 'refunded') then
    return 'link_duplicate';
  end if;
  select * into v_link from public.payment_links where id = v_charge.payment_link_id;

  v_paid := case when (p_payload -> 'payment' ->> 'value') ~ '^\d+(\.\d+)?$'
    then (p_payload -> 'payment' ->> 'value')::numeric end;
  select o.state, s.price into v_state, v_price
    from public.dossier_orders o
    left join public.order_settlements s on s.order_ref = o.dossier_id
   where o.dossier_id = v_link.order_id for update of o;
  -- Valor exato e igual ao da cobrança: sem valor numérico, a mais ou a menos, não avança o pedido.
  if v_paid is null or v_paid <> v_charge.amount then
    return 'amount_mismatch';
  end if;

  update public.pix_charges set status = 'paid' where id = v_charge.id;
  if v_state <> 'awaiting_payment' then
    -- Dinheiro entrou, mas o pedido já não aceita pagamento (pago no balcão, cancelado). Sem pagamento de balcão.
    return 'link_order_not_payable';
  end if;

  insert into public.counter_payments (bureau_id, dossier_id, method, amount, registered_by, note, pix_charge_id)
  values (v_charge.bureau_id, v_link.order_id, 'pix', v_charge.amount, v_charge.requested_by,
    'Pix do link de pagamento', v_charge.id);
  v_after := public.refresh_order_state(v_link.order_id);
  select coalesce(sum(p.amount), 0) into v_sum from public.counter_payments p
   where p.dossier_id = v_link.order_id and p.voided_at is null;
  -- Link consistente: Pix recebido não deixa o link ativo se o pedido avançou ou a soma cobre o preço.
  if v_after <> 'awaiting_payment' or v_sum >= coalesce(v_price, v_sum + 1) then
    perform public.payment_link_mark_paid(v_link.order_id);
  end if;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'payment_link.paid', 'pix_charges', v_charge.id,
    jsonb_build_object('source', 'asaas_webhook', 'payment_link_id', v_link.id, 'order_id', v_link.order_id,
      'amount', v_charge.amount::text));
  if v_price is not null and v_sum > v_price then
    return 'link_overpaid';
  end if;
  return 'link_paid';
end
$$;
