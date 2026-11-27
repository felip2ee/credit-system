-- Estorno e chargeback da comissão sobre a entrada (plano afiliado-bureaus, parte 1, task 6). Esquema na 073.
-- 1) affiliate_wallet_post_entry (069): kind 'commission_clawback' tira do disponível e pode deixá-lo negativo (D5); os
--    saque e conversão seguem recusados abaixo de zero (com saldo <= 0 dão insufficient_funds); liberação de comissão e
--    devolução de saque podem somar a um saldo negativo (abatimento).
-- 2) release_due_commissions (027): lançamento de liberação com origin 'cash_in' quando a comissão é de cobrança.
-- 3) reverse_cash_in_commission(cobrança, evento, corpo): no estorno ou chargeback, por linha de charge_splits:
--    pix (afiliado): comissão pendente -> commission_reversal; já liberada -> commission_clawback (saldo pode ficar
--    negativo e é abatido das próximas comissões); ambos com origin 'cash_in'. accrual (bureau sem walletId): linha
--    'reversal' em bureau_payable_entries ligada ao accrual. asaas (sócio, bureau, afiliado com walletId): o Asaas reverte
--    o split; item REFUNDED vira refunded, item ainda DONE no evento de estorno vira reversal_failed (auditoria).
--    Idempotente: só trata linha pending ou done e a marca refunded; chaves do livro-razão e reverses_entry_id são a
--    segunda barreira. Sem chamada HTTP.
-- 4) apply_asaas_payment (070): chama a função acima no ramo de estorno (antes do clawback do valor a repassar, para não
--    descontar duas vezes) e no estorno de Pix de link. O laço antigo de comissão pendente pula a comissão cash_in.

create or replace function affiliate_wallet_post_entry(
  p_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_created_by uuid,
  p_origin text default 'order'
)
returns table (ok boolean, reason text, entry_id uuid, pending numeric, available numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau_id uuid;
  v_pending numeric;
  v_available numeric;
  v_pending_after numeric;
  v_available_after numeric;
  v_entry public.affiliate_ledger_entries;
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
       'commission', 'commission_release', 'commission_reversal', 'commission_clawback', 'conversion',
       'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, pending, available into v_bureau_id, v_pending, v_available
    from public.affiliate_wallets where profile_id = p_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.affiliate_ledger_entries
   where profile_id = p_profile_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.pending_after, v_entry.available_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_pending_after := v_pending;
  v_available_after := v_available;
  case p_kind
    when 'commission' then
      v_pending_after := v_pending + p_amount;
    when 'commission_release' then
      v_pending_after := v_pending - p_amount;
      v_available_after := v_available + p_amount;
    when 'commission_reversal' then
      v_pending_after := v_pending - p_amount;
    when 'commission_clawback' then
      v_available_after := v_available - p_amount;
    when 'conversion', 'withdrawal_hold' then
      v_available_after := v_available - p_amount;
    when 'withdrawal_release' then
      v_available_after := v_available + p_amount;
    when 'withdrawal_paid' then
      null; -- só registro: o valor já saiu do disponível em withdrawal_hold
  end case;

  -- O disponível só fica negativo pelo clawback (estorno de comissão cash_in já liberada); liberação de comissão e
  -- devolução de saque seguem somando a um saldo negativo (abatimento). Saque e conversão com saldo insuficiente caem aqui.
  if v_pending_after < 0 or (v_available_after < 0 and p_kind in ('conversion', 'withdrawal_hold')) then
    return query select false, 'insufficient_funds'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.affiliate_ledger_entries
    (profile_id, bureau_id, kind, amount, pending_after, available_after, idempotency_key, reference, created_by, origin)
  values
    (p_profile_id, v_bureau_id, p_kind, p_amount, v_pending_after, v_available_after, p_idempotency_key,
     p_reference, p_created_by, p_origin)
  returning id into v_id;
  update public.affiliate_wallets set pending = v_pending_after, available = v_available_after
   where profile_id = p_profile_id;

  return query select true, null::text, v_id, v_pending_after, v_available_after, false;
end
$$;

create or replace function release_due_commissions(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_affiliate uuid;
  v_commission record;
  v_post record;
  v_released integer := 0;
begin
  if public.app_user_id() is not null or public.app_bureau_id() is not null then
    return 0;
  end if;

  for v_affiliate in
    select c.affiliate_profile_id
      from public.affiliate_commissions c
     where c.status = 'pending' and c.release_at <= now()
     group by c.affiliate_profile_id
     order by min(c.release_at), c.affiliate_profile_id
  loop
    exit when v_released >= greatest(p_limit, 0);
    perform 1 from public.affiliate_wallets w where w.profile_id = v_affiliate for update skip locked;
    if not found then
      continue;
    end if;

    for v_commission in
      select c.id, c.order_ref, c.bureau_id, c.affiliate_profile_id, c.amount - c.reversed_amount as rest,
             exists (select 1 from public.pix_charges pc where pc.id = c.order_ref) as cash_in
        from public.affiliate_commissions c
       where c.affiliate_profile_id = v_affiliate and c.status = 'pending' and c.release_at <= now()
       order by c.release_at, c.id
       limit greatest(p_limit, 0) - v_released
         for update skip locked
    loop
      select * into v_post from public.affiliate_wallet_post_entry(
        v_commission.affiliate_profile_id, 'commission_release', v_commission.rest,
        'release:' || v_commission.id::text, 'commission:' || v_commission.id::text,
        v_commission.affiliate_profile_id,
        case when v_commission.cash_in then 'cash_in' else 'order' end);
      if not v_post.ok then
        -- Uma comissão sem lastro na carteira (não deveria existir) não trava as outras: fica pending e vai ao log.
        raise warning 'affiliate commission % not released: %', v_commission.id, v_post.reason;
        continue;
      end if;
      update public.affiliate_commissions set status = 'released' where id = v_commission.id;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_commission.bureau_id, v_commission.affiliate_profile_id, 'affiliate.commission_release',
        'affiliate_commissions', v_commission.id,
        jsonb_build_object('amount', v_commission.rest::text, 'origin', case when v_commission.cash_in then 'cash_in' else 'order' end));
      v_released := v_released + 1;
    end loop;
  end loop;
  return v_released;
end
$$;


create function reverse_cash_in_commission(p_charge_id uuid, p_event_type text, p_payload jsonb)
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
     where s.pix_charge_id = p_charge_id and s.status in ('pending', 'done')
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

    elsif v_line.payout_method = 'asaas' and v_items is not null then
      select i into v_item from jsonb_array_elements(v_items) i
       where jsonb_typeof(i) = 'object'
         and ((v_line.asaas_split_id is not null and i ->> 'id' = v_line.asaas_split_id)
           or (v_line.asaas_split_id is null and i ->> 'walletId' = v_line.asaas_wallet_id))
       limit 1;
      v_new := case upper(v_item ->> 'status') when 'REFUNDED' then 'refunded' when 'DONE' then 'reversal_failed' end;
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

alter function reverse_cash_in_commission(uuid, text, jsonb) owner to auth_profile_lookup;
revoke all on function reverse_cash_in_commission(uuid, text, jsonb) from public, app_runtime;
grant execute on function reverse_cash_in_commission(uuid, text, jsonb) to app_webhook;

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
    -- Dinheiro entrou (a cobrança ficou paga): repasses que o split do Asaas não cobre. Idempotente.
    if v_result in ('link_paid', 'link_overpaid', 'link_order_not_payable') then
      perform public.record_cash_in_commission(v_charge.id);
    elsif v_result = 'link_refund_ignored' and p_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
      -- O pedido não reverte sozinho, mas o dinheiro saiu: reverte os repasses cash_in. Idempotente.
      perform public.reverse_cash_in_commission(v_charge.id, p_event_type, p_payload);
    end if;
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
        -- Afiliado em modo Pix e bureau sem walletId: lançamentos na mesma transação que marca a cobrança como paga.
        -- Recarga do próprio bureau não tem essas linhas. Um webhook repetido cai em 'duplicate' antes daqui.
        perform public.record_cash_in_commission(v_charge.id);
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
               and not exists (select 1 from public.pix_charges pc where pc.id = c.order_ref)
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
      -- Repasses da entrada que o split do Asaas não cobre (afiliado em modo Pix, accrual do bureau) e status das linhas do
      -- split. Antes do clawback: o estorno do accrual já entra no saldo a repassar lido abaixo.
      perform public.reverse_cash_in_commission(v_charge.id, p_event_type, p_payload);
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
