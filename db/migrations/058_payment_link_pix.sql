-- Pix do link de pagamento (/pagar/<token>), sem sessão.
-- Escolha: pix_charges.payment_link_id (nullable) em vez de tabela própria. A cobrança é uma cobrança Pix como as outras
-- (mesmo ciclo reserva -> Asaas -> bind, mesmas checagens do webhook) e as constraints existentes seguem válidas. A
-- cobrança de link é do Bureau (client_profile_id nulo), Pix, sem taxa repassada, e NUNCA credita carteira.
-- 1) pix_charges.payment_link_id, no máximo uma cobrança pending por link.
-- 2) counter_payments.pix_charge_id (único): o pagamento do Pix entra como pagamento de balcão (method pix) e
--    refresh_order_state avança o pedido. A unicidade torna a baixa idempotente.
-- 3) payment_link_charge_reserve / _bind / _cancel / _payer: SECURITY DEFINER, dono auth_profile_lookup (padrão 009/056),
--    EXECUTE só para app_runtime. A página pública não tem sessão; só o id do link (já validado pelo token) entra.
-- 4) apply_payment_link_charge: baixa do webhook, numa transação. apply_asaas_payment (050) só ganha o desvio para ela.
-- 5) Resultados novos do evento de webhook: link_paid, link_duplicate, link_ignored, link_order_not_payable.

alter table pix_charges add column payment_link_id uuid references payment_links(id);
alter table pix_charges add constraint pix_charges_link_shape_check
  check (payment_link_id is null or (client_profile_id is null and billing_type = 'PIX' and fee_amount = 0));
-- Uma cobrança pending por link: a reserva reusa em vez de duplicar. O índice também atende o teto por hora.
create unique index pix_charges_link_pending_idx on pix_charges(payment_link_id) where status = 'pending';
create index pix_charges_link_created_idx on pix_charges(payment_link_id, created_at desc)
  where payment_link_id is not null;

alter table counter_payments add column pix_charge_id uuid unique references pix_charges(id);

alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch',
    'link_paid', 'link_duplicate', 'link_ignored', 'link_order_not_payable'));

-- Dono das funções (auth_profile_lookup é NOBYPASSRLS: só o que estas políticas liberam).
grant insert (bureau_id, external_reference, amount, expires_at, requested_by, payment_link_id)
  on pix_charges to auth_profile_lookup;
create policy pix_charges_gateway_insert on pix_charges for insert to auth_profile_lookup
  with check (payment_link_id is not null and client_profile_id is null and status = 'pending');

grant insert (bureau_id, dossier_id, method, amount, registered_by, note, pix_charge_id)
  on counter_payments to auth_profile_lookup;
create policy counter_payments_gateway_insert on counter_payments for insert to auth_profile_lookup
  with check (method = 'pix' and pix_charge_id is not null and voided_at is null);

-- Pagador do Asaas: o titular da consulta (nome, documento, e-mail do titular ou, na falta, o de quem gerou o link).
grant select (document, email, anonymized_at) on public.holders to auth_profile_lookup;
grant select (email) on public.profiles to auth_profile_lookup;

-- refresh_order_state lê a autorização SCR do pedido. A política da 009 só mostra as de canal internal: sem esta, uma
-- autorização por e-mail ou WhatsApp já concedida contaria como ausente e o pedido pago ficaria em awaiting_authorization.
-- Escopo mínimo: só autorização de consulta de pedido de balcão ainda aguardando pagamento.
-- O teste vai numa função: uma subconsulta direta em consultations (cuja política cita scr_authorizations) daria recursão.
create function scr_authorization_awaits_counter_payment(p_authorization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.consultations c join public.dossier_orders o on o.dossier_id = c.dossier_id
     where c.scr_authorization_id = p_authorization_id and o.mode = 'counter' and o.state = 'awaiting_payment')
$$;
alter function scr_authorization_awaits_counter_payment(uuid) owner to auth_profile_lookup;
revoke all on function scr_authorization_awaits_counter_payment(uuid) from public;
grant execute on function scr_authorization_awaits_counter_payment(uuid) to auth_profile_lookup;
create policy scr_authorizations_gateway_select_counter_order on scr_authorizations for select to auth_profile_lookup
  using (scr_authorization_awaits_counter_payment(id));

-- Auditoria do Pix de link: só o dono das funções, só estas duas ações, e só junto de uma cobrança de link do mesmo
-- Bureau e autor (o solicitante da cobrança é quem gerou o link).
create policy audit_logs_payment_link_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('payment_link.charge_request', 'payment_link.paid')
  and support_session_id is null
  and bureau_id is not null
  and table_name = 'pix_charges'
  and exists (
    select 1 from pix_charges c
     where c.id = audit_logs.record_id
       and c.payment_link_id is not null
       and c.bureau_id = audit_logs.bureau_id
       and c.requested_by = audit_logs.user_id
       and (audit_logs.action <> 'payment_link.paid' or c.status = 'paid')
  )
);

-- Cria ou reusa a cobrança Pix pendente do link. Não chama o Asaas. result:
--   created / reused: há cobrança (external_reference e, no reused, o código Pix);
--   in_progress: outra requisição está criando a cobrança (menos de 2 min);
--   unavailable: link inativo, vencido, pedido fora de awaiting_payment ou sem preço;
--   amount_out_of_range: preço fora de 10,00..5.000,00 (limite de pix_charges.amount);
--   rate_limited: 5 cobranças do link na última hora.
create function payment_link_charge_reserve(p_link_id uuid)
returns table (result text, charge_id uuid, external_reference uuid, amount numeric, pix_payload text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link public.payment_links;
  v_price numeric;
  v_cur public.pix_charges;
  v_ref uuid;
  v_id uuid;
  v_exp timestamptz;
begin
  if p_link_id is null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment-link-charge:' || p_link_id::text, 0));

  select l.* into v_link from public.payment_links l
    join public.bureaus b on b.id = l.bureau_id and b.status = 'active'
   where l.id = p_link_id;
  if v_link.id is null or v_link.status <> 'active' or v_link.expires_at <= now() then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
    return;
  end if;
  select s.price into v_price
    from public.dossier_orders o
    left join public.order_settlements s on s.order_ref = o.dossier_id
   where o.dossier_id = v_link.order_id and o.bureau_id = v_link.bureau_id
     and o.mode = 'counter' and o.state = 'awaiting_payment';
  if v_price is null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
    return;
  end if;
  if v_price < 10.00 or v_price > 5000.00 then
    return query select 'amount_out_of_range'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
    return;
  end if;

  select * into v_cur from public.pix_charges c where c.payment_link_id = p_link_id and c.status = 'pending' for update;
  if v_cur.id is not null then
    if v_cur.expires_at > now() and v_cur.amount = v_price then
      if v_cur.asaas_payment_id is not null and v_cur.pix_payload is not null then
        return query select 'reused'::text, v_cur.id, v_cur.external_reference, v_cur.amount, v_cur.pix_payload, v_cur.expires_at;
        return;
      end if;
      if v_cur.asaas_payment_id is null and v_cur.created_at > now() - interval '2 minutes' then
        return query select 'in_progress'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
        return;
      end if;
    end if;
    -- Vencida, de outro valor ou presa sem id do Asaas: sai do caminho. Se o Asaas a criou, o webhook ainda a baixa.
    update public.pix_charges set status = case when asaas_payment_id is null then 'cancelled' else 'expired' end
     where id = v_cur.id;
  end if;

  if (select count(*) from public.pix_charges c
       where c.payment_link_id = p_link_id and c.created_at > now() - interval '1 hour') >= 5 then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::numeric, null::text, null::timestamptz;
    return;
  end if;

  v_ref := gen_random_uuid();
  insert into public.pix_charges (bureau_id, external_reference, amount, expires_at, requested_by, payment_link_id)
  values (v_link.bureau_id, v_ref, v_price, now() + interval '30 minutes', v_link.created_by, p_link_id)
  returning id, pix_charges.expires_at into v_id, v_exp;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_link.bureau_id, v_link.created_by, 'payment_link.charge_request', 'pix_charges', v_id,
    jsonb_build_object('payment_link_id', p_link_id, 'order_id', v_link.order_id, 'amount', v_price::text));
  return query select 'created'::text, v_id, v_ref, v_price, null::text, v_exp;
end
$$;

-- Liga a cobrança reservada ao pagamento do Asaas. Repetir o mesmo id é inofensivo (o webhook pode ter ligado antes).
create function payment_link_charge_bind(p_charge_id uuid, p_asaas_payment_id text, p_pix_payload text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
begin
  if p_charge_id is null or p_asaas_payment_id is null or btrim(p_asaas_payment_id) = ''
     or p_pix_payload is null or btrim(p_pix_payload) = '' then
    return false;
  end if;
  select * into v_charge from public.pix_charges
   where id = p_charge_id and payment_link_id is not null for update;
  if v_charge.id is null or v_charge.status not in ('pending', 'paid') then
    return false;
  end if;
  if v_charge.asaas_payment_id is null then
    update public.pix_charges set asaas_payment_id = p_asaas_payment_id, pix_payload = p_pix_payload
     where id = v_charge.id;
    return true;
  end if;
  if v_charge.pix_payload is null then
    update public.pix_charges set pix_payload = p_pix_payload where id = v_charge.id;
  end if;
  return v_charge.asaas_payment_id = p_asaas_payment_id;
end
$$;

-- O Asaas recusou de vez (4xx): fecha a cobrança sem id para ela não ficar pending. Só link, só sem id.
create function payment_link_charge_cancel(p_charge_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.pix_charges set status = 'cancelled'
   where id = p_charge_id and payment_link_id is not null and status = 'pending' and asaas_payment_id is null;
  return found;
end
$$;

-- Dados do pagador para criar o cliente Asaas. Só enquanto a cobrança é nova (pending, sem id, menos de 2 min), para o
-- id de cobrança não servir de consulta ao documento. Sem documento (titular anonimizado) não devolve linha.
create function payment_link_charge_payer(p_charge_id uuid)
returns table (payer_name text, payer_document text, payer_email text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select h.name, regexp_replace(h.document, '\D', '', 'g'), coalesce(nullif(btrim(h.email), ''), p.email)
    from public.pix_charges c
    join public.payment_links l on l.id = c.payment_link_id
    join public.dossiers d on d.id = l.order_id and d.bureau_id = l.bureau_id
    join public.holders h on h.id = d.holder_id and h.bureau_id = l.bureau_id
    join public.profiles p on p.id = l.created_by
   where c.id = p_charge_id and c.status = 'pending' and c.asaas_payment_id is null
     and c.created_at > now() - interval '2 minutes'
     and h.document is not null and h.anonymized_at is null
$$;

-- Baixa do webhook para cobrança de link, chamada só por apply_asaas_payment (já com o evento gravado). Numa transação:
-- confere o valor, marca a cobrança paga, insere o pagamento de balcão Pix, baixa o link e avança o pedido.
-- Valor pago diferente do esperado (preço do pedido): nada avança. Nunca credita carteira.
create function apply_payment_link_charge(p_charge_id uuid, p_event_type text, p_payload jsonb)
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
begin
  if p_event_type not in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    -- Estorno de Pix de link: o pedido já pode ter avançado. A operação decide; só o evento fica gravado.
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
  -- Valor exato e igual ao preço de agora: sem valor numérico, a mais ou a menos, não avança o pedido.
  if v_paid is null or v_paid <> v_charge.amount or v_price is null or v_price <> v_charge.amount then
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
  perform public.payment_link_mark_paid(v_link.order_id);
  perform public.refresh_order_state(v_link.order_id);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_charge.bureau_id, v_charge.requested_by, 'payment_link.paid', 'pix_charges', v_charge.id,
    jsonb_build_object('source', 'asaas_webhook', 'payment_link_id', v_link.id, 'order_id', v_link.order_id,
      'amount', v_charge.amount::text));
  return 'link_paid';
end
$$;

alter function payment_link_charge_reserve(uuid) owner to auth_profile_lookup;
alter function payment_link_charge_bind(uuid, text, text) owner to auth_profile_lookup;
alter function payment_link_charge_cancel(uuid) owner to auth_profile_lookup;
alter function payment_link_charge_payer(uuid) owner to auth_profile_lookup;
alter function apply_payment_link_charge(uuid, text, jsonb) owner to auth_profile_lookup;
revoke all on function payment_link_charge_reserve(uuid) from public;
revoke all on function payment_link_charge_bind(uuid, text, text) from public;
revoke all on function payment_link_charge_cancel(uuid) from public;
revoke all on function payment_link_charge_payer(uuid) from public;
revoke all on function apply_payment_link_charge(uuid, text, jsonb) from public;
grant execute on function payment_link_charge_reserve(uuid) to app_runtime;
grant execute on function payment_link_charge_bind(uuid, text, text) to app_runtime;
grant execute on function payment_link_charge_cancel(uuid) to app_runtime;
grant execute on function payment_link_charge_payer(uuid) to app_runtime;
-- apply_payment_link_charge: sem grant. Só o dono (apply_asaas_payment) a chama.

-- apply_asaas_payment (050): o corpo é o da 050 com dois desvios para cobrança de link (reenvio e baixa). Dono e grants
-- (app_webhook) vêm da 014/043; create or replace os mantém.
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
