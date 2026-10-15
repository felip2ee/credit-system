-- M3b: segunda leva de correções do painel. A 003–018 já foram aplicadas e não mudam.
-- 1) Reserva retomada por estorno de PIX: capture_order e release_order deixam de travar o pedido em 'reserved'.
--    release_order devolve ao disponível o que sobrou da reserva (no máximo o valor do pedido) e fecha o pedido como
--    'released'. capture_order não captura: devolve o que sobrou, fecha o pedido como 'released', não gera valor a
--    repassar e responde ok = false com reason 'reservation_clawed_back' e status 'released'. A função não levanta
--    erro: o fechamento é gravado (o chamador não deve desfazer a transação por causa dessa resposta).
-- 2) nfse_charge_by_payment só devolve cobrança paga: nenhuma nota fiscal nasce de uma cobrança estornada.
-- 3) PAYMENT_REFUNDED numa cobrança 'pending' marca a cobrança como 'refunded' (sem mexer em dinheiro).
-- 4) Sai o índice pix_charges_bureau_created_idx (012): a 018 criou pix_charges_bureau_own_created_idx, que atende
--    a lista de cobranças do Bureau (client_profile_id is null); as consultas de cobrança do cliente usam
--    pix_charges_client_created_idx.

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

  -- Valor que a captura tira da reserva e o que a carteira ainda tem reservado (sob trava). Balcão com custo 0 não
  -- toca a carteira (v_reserved fica nulo).
  v_amount := case when v_s.mode = 'online' then v_s.price else v_s.cost end;
  if v_s.mode = 'online' then
    select reserved into v_reserved from public.client_wallets
     where client_profile_id = v_s.client_profile_id for update;
  elsif v_s.cost > 0 then
    select reserved into v_reserved from public.wallets where bureau_id = v_s.bureau_id for update;
  end if;

  if v_reserved < v_amount then
    -- Um estorno de PIX retomou a reserva: não há o que capturar. Devolve o que sobrou e fecha o pedido.
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

-- 1) Liberação. Devolve least(reservado, valor do pedido); sem reserva sobrando fecha o pedido sem lançamento.
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
    v_amount := least(v_reserved, v_amount);
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
  v_audit_table text;
  v_audit_record uuid;
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

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
      update public.pix_charges set status = 'refunded', refund_shortfall = v_shortfall where id = v_charge.id;
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
          'amount', v_reversed::text, 'shortfall', v_shortfall::text));
      v_result := 'refunded';
    end if;
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
