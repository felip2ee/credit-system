-- M3b: segunda leva de correções do painel. A 003–018 já foram aplicadas e não mudam.
-- 1) Reserva retomada por estorno de PIX: capture_order e release_order deixam de travar o pedido em 'reserved'.
--    release_order devolve ao disponível o que sobrou da reserva (no máximo o valor do pedido) e fecha o pedido como
--    'released'. capture_order não captura: devolve o que sobrou, fecha o pedido como 'released', não gera valor a
--    repassar e responde ok = false com reason 'reservation_clawed_back' e status 'released'. A função não levanta
--    erro: o fechamento é gravado (o chamador não deve desfazer a transação por causa dessa resposta).
-- 2) nfse_charge_by_payment só devolve cobrança paga: nenhuma nota fiscal nasce de uma cobrança estornada.
-- 3) PAYMENT_REFUNDED numa cobrança 'pending' marca a cobrança como 'refunded' (sem mexer em dinheiro).
-- 5) A reserva restante é por pedido, não do saldo reservado da carteira: um estorno de PIX consome os pedidos abertos
--    do mais antigo ao mais novo (order_settlements.seq) e capture_order/release_order usam só o que sobra ao próprio
--    pedido (order_reservation_left). Um pedido não perde nem devolve a reserva de outro.
-- 6) Estorno de PIX do cliente: o que a carteira não cobre (refund_shortfall) estorna, até o saldo a repassar ainda
--    não pago do Bureau, o valor a repassar (lançamento reversal em bureau_payable_entries, ligado à cobrança por
--    pix_charge_id). refund_shortfall guarda só o que restou depois disso.
-- 7) PAYMENT_PARTIALLY_REFUNDED não mexe em saldo: o evento fica registrado com o resultado 'partial_refund_ignored'.
-- 4) Sai o índice pix_charges_bureau_created_idx (012): a 018 criou pix_charges_bureau_own_created_idx, que atende
--    a lista de cobranças do Bureau (client_profile_id is null); as consultas de cobrança do cliente usam
--    pix_charges_client_created_idx.
-- 8) Cobrança PIX do cliente nasce antes da chamada ao Asaas, com external_reference. O id do pagamento e o código PIX
--    entram depois, por bind_pix_charge. Falha do Asaas fecha a linha por cancel_unbound_pix_charge (não conta no teto).
--    O webhook acha a cobrança também por payment.externalReference, quando o bind falhou.

-- 8) Cobrança sem id de pagamento: a referência externa a identifica até o bind. Pago ou estornado exige o id (o webhook
-- o grava ao achar a cobrança pela referência).
alter table pix_charges alter column asaas_payment_id drop not null;
alter table pix_charges alter column pix_payload drop not null;
alter table pix_charges add column external_reference uuid unique;
alter table pix_charges add constraint pix_charges_unbound_check
  check (asaas_payment_id is not null or (external_reference is not null and status in ('pending', 'cancelled')));
grant insert (external_reference) on pix_charges to app_runtime;
grant update (asaas_payment_id, pix_payload) on pix_charges to auth_profile_lookup;

-- 8) Liga a cobrança pré-criada ao pagamento do Asaas. Só o autor, só enquanto pendente e sem id; repetir o mesmo id é
-- inofensivo (o webhook pode ter ligado antes). Uma única transição: asaas_payment_id e pix_payload saem de nulo.
create function bind_pix_charge(p_charge_id uuid, p_asaas_payment_id text, p_pix_payload text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
begin
  if not public.app_context_present() or public.app_user_id() is null or p_charge_id is null
     or p_asaas_payment_id is null or btrim(p_asaas_payment_id) = ''
     or p_pix_payload is null or btrim(p_pix_payload) = '' then
    return false;
  end if;
  select * into v_charge from public.pix_charges
   where id = p_charge_id and requested_by = public.app_user_id() and bureau_id = public.app_bureau_id()
   for update;
  if v_charge.id is null or v_charge.status <> 'pending' then
    return false;
  end if;
  if v_charge.asaas_payment_id is null then
    update public.pix_charges set asaas_payment_id = p_asaas_payment_id, pix_payload = p_pix_payload
     where id = v_charge.id;
    return true;
  end if;
  return v_charge.asaas_payment_id = p_asaas_payment_id;
end
$$;

-- 8) Fecha a cobrança que o Asaas não criou: sai do teto de pendentes. Só o autor, só sem id de pagamento.
create function cancel_unbound_pix_charge(p_charge_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.app_context_present() or public.app_user_id() is null or p_charge_id is null then
    return false;
  end if;
  update public.pix_charges set status = 'cancelled'
   where id = p_charge_id and requested_by = public.app_user_id() and bureau_id = public.app_bureau_id()
     and status = 'pending' and asaas_payment_id is null;
  return found;
end
$$;

alter function bind_pix_charge(uuid, text, text) owner to auth_profile_lookup;
alter function cancel_unbound_pix_charge(uuid) owner to auth_profile_lookup;
revoke all on function bind_pix_charge(uuid, text, text) from public;
revoke all on function cancel_unbound_pix_charge(uuid) from public;
grant execute on function bind_pix_charge(uuid, text, text) to app_runtime;
grant execute on function cancel_unbound_pix_charge(uuid) to app_runtime;

-- 5) Ordem dos pedidos de uma carteira: seq cresce a cada reserva (created_at empata na mesma transação).
alter table order_settlements add column seq bigint generated always as identity;

-- 6) Lançamento reversal do valor a repassar aponta para a cobrança estornada (uma vez por cobrança).
alter table bureau_payable_entries add column pix_charge_id uuid references pix_charges(id);
alter table bureau_payable_entries add constraint bureau_payable_entries_charge_link
  check (kind = 'reversal' or pix_charge_id is null);
create unique index bureau_payable_entries_reversal_charge_idx on bureau_payable_entries(pix_charge_id)
  where kind = 'reversal';

-- 7) Resultado novo do evento de webhook.
alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored'));

-- 5) Reserva que ainda resta a um pedido aberto. A carteira guarda o reservado num só saldo (a soma dos pedidos
-- abertos) e o reversal do estorno tira dele sem dizer de qual pedido. Regra: o estorno consome do pedido mais
-- antigo ao mais novo, então o saldo que sobrou pertence aos mais novos: o pedido fica com o menor valor entre o seu
-- e o saldo menos o que os pedidos mais novos da mesma carteira (cliente online; Bureau no balcão) já reservam.
-- Interna: só capture_order e release_order chamam, com a carteira travada.
create function order_reservation_left(p_order_ref uuid, p_wallet_reserved numeric)
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select greatest(0, least(
      case when s.mode = 'online' then s.price else s.cost end,
      p_wallet_reserved - coalesce((
        select sum(case when o.mode = 'online' then o.price else o.cost end)
          from public.order_settlements o
         where o.status = 'reserved' and o.seq > s.seq and o.mode = s.mode and o.bureau_id = s.bureau_id
           and o.client_profile_id is not distinct from s.client_profile_id), 0)))
    from public.order_settlements s
   where s.order_ref = p_order_ref
$$;

alter function order_reservation_left(uuid, numeric) owner to auth_profile_lookup;
revoke all on function order_reservation_left(uuid, numeric) from public;

-- 1) Captura. Ordem de travas igual à 015: liquidação -> carteira do cliente -> carteira do Bureau.
create or replace function capture_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
  v_amount numeric;
  v_reserved numeric;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'released' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  -- Valor que a captura tira da reserva e o que ainda resta da reserva deste pedido (a carteira travada; ver
  -- order_reservation_left). Balcão com custo 0 não toca a carteira (v_reserved fica nulo).
  v_amount := case when v_s.mode = 'online' then v_s.price else v_s.cost end;
  if v_s.mode = 'online' then
    select reserved into v_reserved from public.client_wallets
     where client_profile_id = v_s.client_profile_id for update;
  elsif v_s.cost > 0 then
    select reserved into v_reserved from public.wallets where bureau_id = v_s.bureau_id for update;
  end if;
  if v_reserved is not null then
    v_reserved := public.order_reservation_left(v_s.order_ref, v_reserved);
  end if;

  if v_reserved < v_amount then
    -- Um estorno de PIX retomou a reserva deste pedido: não há o que capturar. Devolve o que sobrou dela e fecha o pedido.
    if v_reserved > 0 then
      if v_s.mode = 'online' then
        select * into v_post from public.client_wallet_post_entry(
          v_s.client_profile_id, 'release', v_reserved, 'order:release:' || p_order_ref::text,
          'order:' || p_order_ref::text, null, v_user);
      else
        select * into v_post from public.wallet_post_entry(
          v_s.bureau_id, 'release', v_reserved, 'order:release:' || p_order_ref::text,
          'order:' || p_order_ref::text, null, v_user);
      end if;
      if not v_post.ok then
        raise exception 'order release failed: %', v_post.reason;
      end if;
    end if;
    update public.order_settlements set status = 'released', closed_at = now() where id = v_s.id;
    return query select false, 'reservation_clawed_back'::text, 'released'::text;
    return;
  end if;

  if v_s.mode = 'online' then
    select * into v_post from public.client_wallet_post_entry(
      v_s.client_profile_id, 'capture', v_s.price, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      return query select false, v_post.reason, v_s.status;
      return;
    end if;
    if v_s.price > v_s.cost then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
      values (v_s.bureau_id, 'accrual', v_s.price - v_s.cost, v_s.order_ref);
    end if;
  elsif v_s.cost > 0 then
    select * into v_post from public.wallet_post_entry(
      v_s.bureau_id, 'capture', v_s.cost, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      return query select false, v_post.reason, v_s.status;
      return;
    end if;
  end if;

  update public.order_settlements set status = 'captured', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'captured'::text;
end
$$;

-- 1) Liberação. Devolve o que resta da reserva do pedido (no máximo o valor dele); sem reserva sobrando fecha o pedido sem lançamento.
create or replace function release_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
  v_amount numeric;
  v_reserved numeric;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'released' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  v_amount := case when v_s.mode = 'online' then v_s.price else v_s.cost end;
  if v_s.mode = 'online' then
    select reserved into v_reserved from public.client_wallets
     where client_profile_id = v_s.client_profile_id for update;
  elsif v_s.cost > 0 then
    select reserved into v_reserved from public.wallets where bureau_id = v_s.bureau_id for update;
  end if;

  select true as ok, null::text as reason into v_post;
  if v_reserved is not null then
    v_amount := public.order_reservation_left(v_s.order_ref, v_reserved);
  end if;
  if v_amount > 0 and (v_s.mode = 'online' or v_s.cost > 0) then
    if v_s.mode = 'online' then
      select * into v_post from public.client_wallet_post_entry(
        v_s.client_profile_id, 'release', v_amount, 'order:release:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    else
      select * into v_post from public.wallet_post_entry(
        v_s.bureau_id, 'release', v_amount, 'order:release:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    end if;
  end if;
  if not v_post.ok then
    return query select false, v_post.reason, v_s.status;
    return;
  end if;

  update public.order_settlements set status = 'released', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'released'::text;
end
$$;

-- 3) Webhook (018) com o estorno de cobrança pendente.
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
  v_audit_table text;
  v_audit_record uuid;
  v_ref text;
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

  -- Reserva: o bind do id do pagamento falhou. A cobrança sem id é achada por payment.externalReference e ganha o id.
  -- O valor creditado continua sendo pix_charges.amount.
  if v_charge.id is null then
    v_ref := p_payload -> 'payment' ->> 'externalReference';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_charge from public.pix_charges
       where external_reference = v_ref::uuid and asaas_payment_id is null for update;
      if v_charge.id is not null then
        update public.pix_charges set asaas_payment_id = p_asaas_payment_id where id = v_charge.id;
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
    return 'duplicate';
  end if;

  if v_charge.id is null then
    v_result := 'unknown_charge';
  elsif p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status in ('paid', 'refunded') then
      v_result := 'duplicate';
    elsif v_charge.status = 'cancelled' then
      v_result := 'ignored';
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
  elsif p_event_type = 'PAYMENT_REFUNDED' then
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
      -- Cobrança do cliente: o que a carteira não cobre pode já ter virado valor a repassar ao Bureau (pedido capturado
      -- depois da recarga). Estorna-se esse valor, até o saldo a repassar ainda não pago. O lock é o de create_payout:
      -- um repasse em curso e este estorno se enfileiram. O que sobra continua em refund_shortfall (o M6 cobre).
      if v_charge.client_profile_id is not null and v_shortfall > 0 then
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('payout:' || v_charge.bureau_id::text, 0));
        select coalesce(sum(e.amount), 0) into v_payable
          from public.bureau_payable_entries e where e.bureau_id = v_charge.bureau_id;
        v_clawback := least(v_shortfall, greatest(v_payable, 0));
      end if;
      update public.pix_charges
         set status = 'refunded', refund_shortfall = v_shortfall - v_clawback where id = v_charge.id;
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
          'amount', v_reversed::text, 'shortfall', v_shortfall::text, 'payable_reversal', v_clawback::text));
      v_result := 'refunded';
    end if;
  elsif p_event_type = 'PAYMENT_PARTIALLY_REFUNDED' then
    -- Estorno parcial: o M6 decide como tratar o dinheiro. Aqui nenhum saldo muda; o evento fica gravado (com o corpo)
    -- sob este resultado, que a operação enxerga.
    v_result := 'partial_refund_ignored';
  else
    v_result := 'ignored';
  end if;

  update public.asaas_webhook_events set result = v_result where id = v_event_row;
  return v_result;
end
$$;

-- 2) Webhook: só cobrança paga. set_nfse_status (016) segue aceitando 'paid' e 'refunded' para a cobrança que foi
-- paga, recebeu a nota e só depois foi estornada; o que muda é que um estorno não abre mais nota nova.
create or replace function nfse_charge_by_payment(p_asaas_payment_id text)
returns table (charge_id uuid, amount numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.amount
    from public.pix_charges c
   where c.asaas_payment_id = p_asaas_payment_id
     and c.status = 'paid'
$$;

-- 4) Sem consulta: a lista do Bureau usa pix_charges_bureau_own_created_idx (018).
drop index pix_charges_bureau_created_idx;
