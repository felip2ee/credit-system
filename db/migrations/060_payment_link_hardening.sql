-- Endurecimento do Pix do link de pagamento (revisão de segurança da 058). Corpos iguais aos da 058, salvo o que segue.
-- H1) O Pix do link cobra o que falta (preço menos pagamentos de balcão não anulados), não o preço cheio. A baixa confere
--     o valor pago contra o valor da cobrança E contra o que falta agora (sob o lock do pedido).
-- M1) payment_link_charge_reserve devolve o id Asaas da cobrança que ela tirou do caminho (stale_asaas_payment_id), para
--     o app cancelar o pagamento no Asaas (melhor esforço).
-- M2) Estorno e chargeback de Pix de link deixam de ser silenciosos: resultado link_refund_ignored. Cobrança ainda
--     pending que recebe estorno vira refunded, para um PAYMENT_RECEIVED tardio não baixar o pedido.
-- L1) payment_link_mark_paid deixa de ser executável por app_webhook: só apply_payment_link_charge (dono) a chama.
-- L4) payment_link_charge_payer devolve o id do titular: o app usa como referência estável do cliente Asaas.

alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch',
    'link_paid', 'link_duplicate', 'link_ignored', 'link_order_not_payable', 'link_refund_ignored'));

revoke execute on function payment_link_mark_paid(uuid) from app_webhook;

-- Cria ou reusa a cobrança Pix pendente do link. Não chama o Asaas. result:
--   created / reused: há cobrança (external_reference e, no reused, o código Pix); amount é o que falta pagar;
--   in_progress: outra requisição está criando a cobrança (menos de 2 min);
--   unavailable: link inativo, vencido, pedido fora de awaiting_payment, sem preço ou já coberto por pagamentos;
--   amount_out_of_range: o que falta fora de 10,00..5.000,00 (limite de pix_charges.amount);
--   rate_limited: 5 cobranças do link na última hora.
-- stale_asaas_payment_id: pagamento Asaas da cobrança anterior que esta chamada fechou (para cancelar lá), ou nulo.
drop function payment_link_charge_reserve(uuid);
create function payment_link_charge_reserve(p_link_id uuid)
returns table (result text, charge_id uuid, external_reference uuid, amount numeric, pix_payload text,
  expires_at timestamptz, stale_asaas_payment_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link public.payment_links;
  v_price numeric;
  v_paid numeric;
  v_remaining numeric;
  v_cur public.pix_charges;
  v_stale text;
  v_ref uuid;
  v_id uuid;
  v_exp timestamptz;
begin
  if p_link_id is null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment-link-charge:' || p_link_id::text, 0));

  select l.* into v_link from public.payment_links l
    join public.bureaus b on b.id = l.bureau_id and b.status = 'active'
   where l.id = p_link_id;
  if v_link.id is null or v_link.status <> 'active' or v_link.expires_at <= now() then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
    return;
  end if;
  select s.price into v_price
    from public.dossier_orders o
    left join public.order_settlements s on s.order_ref = o.dossier_id
   where o.dossier_id = v_link.order_id and o.bureau_id = v_link.bureau_id
     and o.mode = 'counter' and o.state = 'awaiting_payment';
  if v_price is null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
    return;
  end if;
  -- Pagamento parcial no balcão: o Pix cobra só o que falta (a mesma conta de refresh_order_state).
  select coalesce(sum(p.amount), 0) into v_paid from public.counter_payments p
   where p.dossier_id = v_link.order_id and p.voided_at is null;
  v_remaining := v_price - v_paid;
  if v_remaining <= 0 then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
    return;
  end if;
  if v_remaining < 10.00 or v_remaining > 5000.00 then
    return query select 'amount_out_of_range'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
    return;
  end if;

  select * into v_cur from public.pix_charges c where c.payment_link_id = p_link_id and c.status = 'pending' for update;
  if v_cur.id is not null then
    if v_cur.expires_at > now() and v_cur.amount = v_remaining then
      if v_cur.asaas_payment_id is not null and v_cur.pix_payload is not null then
        return query select 'reused'::text, v_cur.id, v_cur.external_reference, v_cur.amount, v_cur.pix_payload, v_cur.expires_at, null::text;
        return;
      end if;
      if v_cur.asaas_payment_id is null and v_cur.created_at > now() - interval '2 minutes' then
        return query select 'in_progress'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, null::text;
        return;
      end if;
    end if;
    -- Vencida, de outro valor ou presa sem id do Asaas: sai do caminho. Se o Asaas a criou, o webhook ainda a baixa.
    update public.pix_charges set status = case when asaas_payment_id is null then 'cancelled' else 'expired' end
     where id = v_cur.id;
    v_stale := v_cur.asaas_payment_id;
  end if;

  if (select count(*) from public.pix_charges c
       where c.payment_link_id = p_link_id and c.created_at > now() - interval '1 hour') >= 5 then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz, v_stale;
    return;
  end if;

  v_ref := gen_random_uuid();
  insert into public.pix_charges (bureau_id, external_reference, amount, expires_at, requested_by, payment_link_id)
  values (v_link.bureau_id, v_ref, v_remaining, now() + interval '30 minutes', v_link.created_by, p_link_id)
  returning id, pix_charges.expires_at into v_id, v_exp;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_link.bureau_id, v_link.created_by, 'payment_link.charge_request', 'pix_charges', v_id,
    jsonb_build_object('payment_link_id', p_link_id, 'order_id', v_link.order_id, 'amount', v_remaining::text));
  return query select 'created'::text, v_id, v_ref, v_remaining, null::text, v_exp, v_stale;
end
$$;

alter function payment_link_charge_reserve(uuid) owner to auth_profile_lookup;
revoke all on function payment_link_charge_reserve(uuid) from public;
grant execute on function payment_link_charge_reserve(uuid) to app_runtime;

-- Dados do pagador para criar o cliente Asaas. Só enquanto a cobrança é nova (pending, sem id, menos de 2 min), para o
-- id de cobrança não servir de consulta ao documento. Sem documento (titular anonimizado) não devolve linha.
-- holder_id: referência estável do cliente Asaas (o mesmo titular reusa o cliente em vez de criar outro a cada cobrança).
drop function payment_link_charge_payer(uuid);
create function payment_link_charge_payer(p_charge_id uuid)
returns table (payer_name text, payer_document text, payer_email text, holder_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select h.name, regexp_replace(h.document, '\D', '', 'g'), coalesce(nullif(btrim(h.email), ''), p.email), h.id
    from public.pix_charges c
    join public.payment_links l on l.id = c.payment_link_id
    join public.dossiers d on d.id = l.order_id and d.bureau_id = l.bureau_id
    join public.holders h on h.id = d.holder_id and h.bureau_id = l.bureau_id
    join public.profiles p on p.id = l.created_by
   where c.id = p_charge_id and c.status = 'pending' and c.asaas_payment_id is null
     and c.created_at > now() - interval '2 minutes'
     and h.document is not null and h.anonymized_at is null
$$;

alter function payment_link_charge_payer(uuid) owner to auth_profile_lookup;
revoke all on function payment_link_charge_payer(uuid) from public;
grant execute on function payment_link_charge_payer(uuid) to app_runtime;

-- Baixa do webhook para cobrança de link, chamada só por apply_asaas_payment (já com o evento gravado). Numa transação:
-- confere o valor, marca a cobrança paga, insere o pagamento de balcão Pix, baixa o link e avança o pedido.
-- O valor pago tem de ser igual ao da cobrança e, com o pedido aguardando pagamento, ao que falta agora (preço menos
-- pagamentos de balcão não anulados): senão nada avança (amount_mismatch). Nunca credita carteira.
-- Estorno e chargeback: link_refund_ignored (a operação decide). Cobrança pending que recebe estorno vira refunded.
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
  v_price numeric;
  v_paid numeric;
  v_remaining numeric;
begin
  if p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
                      'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    -- Estorno de Pix de link: o pedido já pode ter avançado. A operação decide; o resultado próprio tira o evento do
    -- silêncio. Antes do pagamento (eventos fora de ordem) a cobrança vira refunded, como na 050: um RECEIVED tardio
    -- cai em link_duplicate e não baixa o pedido.
    if p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
      update public.pix_charges set status = 'refunded'
       where id = p_charge_id and payment_link_id is not null and status = 'pending';
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
  if v_state = 'awaiting_payment' then
    -- Pagamento de balcão que entrou depois da reserva muda o que falta: a cobrança deixou de cobrir o pedido.
    select v_price - coalesce(sum(p.amount), 0) into v_remaining from public.counter_payments p
     where p.dossier_id = v_link.order_id and p.voided_at is null;
    if v_price is null or v_remaining <> v_charge.amount then
      return 'amount_mismatch';
    end if;
  end if;

  update public.pix_charges set status = 'paid' where id = v_charge.id;
  if v_state <> 'awaiting_payment' then
    -- Dinheiro entrou, mas o pedido já não aceita pagamento (pago no balcão, cancelado). Sem pagamento de balcão.
    return 'link_order_not_payable';
  end if;

  insert into public.counter_payments (bureau_id, dossier_id, method, amount, registered_by, note, pix_charge_id)
  values (v_charge.bureau_id, v_link.order_id, 'pix', v_charge.amount, v_charge.requested_by,
    'Pix do link de pagamento', v_charge.id);
  perform public.payment_link_mark_paid(v_link.order_id);
  perform public.refresh_order_state(v_link.order_id);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'payment_link.paid', 'pix_charges', v_charge.id,
    jsonb_build_object('source', 'asaas_webhook', 'payment_link_id', v_link.id, 'order_id', v_link.order_id,
      'amount', v_charge.amount::text));
  return 'link_paid';
end
$$;
