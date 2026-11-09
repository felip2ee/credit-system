-- Correções da revisão do cartão.
-- 1) apply_asaas_payment (041): PAYMENT_CHARGEBACK_REQUESTED reverte o crédito como PAYMENT_REFUNDED (mesmo teto, mesma
--    chave de idempotência, comissão e refund_shortfall); PAYMENT_CHARGEBACK_DISPUTE e
--    PAYMENT_AWAITING_CHARGEBACK_REVERSAL gravam o resultado 'chargeback_ignored'. Antes de creditar, payment.value menor
--    que o esperado (além da tolerância) grava 'amount_mismatch' e não credita. Assinatura, dono e grants não mudam.
-- 2) bind_pix_charge (040): cobrança de cartão já paga (o webhook ganhou a corrida) ainda aceita o bind; só os campos
--    nulos mudam. Pix inalterado.
-- 3) nfse_charge_by_payment: acha também pelo parcelamento (payment.installment).
-- 4) pix_charges.request_ip e as contagens de tentativas de cartão por IP e por Bureau.

-- 1) Resultados novos do evento de webhook (check da 019) e o corpo novo da função.
alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge',
    'partial_refund_ignored', 'chargeback_ignored', 'amount_mismatch'));

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
      -- Valor pago (payment.value) contra o esperado. Abaixo do esperado, além da tolerância: não credita. Igual ou
      -- acima credita o valor da linha (juros e multa nunca travam um pagamento real). Sem valor numérico: credita.
      -- Pix: amount. Cartão: total cobrado dividido pelas parcelas, com tolerância de n centavos (o resto vai na última).
      v_paid := case when (p_payload -> 'payment' ->> 'value') ~ '^-?\d+(\.\d+)?$'
        then (p_payload -> 'payment' ->> 'value')::numeric end;
      if v_charge.billing_type = 'CREDIT_CARD' then
        v_expected := coalesce(v_charge.total_charged, v_charge.amount) / v_charge.installments;
        v_tolerance := v_charge.installments * 0.01;
      else
        v_expected := v_charge.amount;
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
           and e.kind in ('accrual', 'reversal')
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

-- 2) bind_pix_charge: corpo da 040; muda só o teste de status. Assinatura, dono e grants não mudam.
create or replace function bind_pix_charge(
  p_id uuid,
  p_payment text,
  p_payload text default null,
  p_installment text default null,
  p_brand text default null,
  p_last4 text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_installment text := nullif(btrim(p_installment), '');
  v_brand text := left(nullif(btrim(p_brand), ''), 20);
  v_last4 text := case when p_last4 ~ '^\d{4}$' then p_last4 end;
begin
  if not public.app_context_present() or public.app_user_id() is null or p_id is null
     or p_payment is null or btrim(p_payment) = '' then
    return false;
  end if;
  select * into v_charge from public.pix_charges
   where id = p_id and requested_by = public.app_user_id() and bureau_id = public.app_bureau_id()
   for update;
  -- Cartão: o webhook pode ter creditado antes do bind (status paid). Os campos nulos ainda entram.
  if v_charge.id is null
     or not (v_charge.status = 'pending' or (v_charge.billing_type = 'CREDIT_CARD' and v_charge.status = 'paid')) then
    return false;
  end if;
  if v_charge.billing_type = 'PIX' and (p_payload is null or btrim(p_payload) = '') then
    return false;
  end if;
  if v_charge.asaas_payment_id is null or v_charge.asaas_payment_id = p_payment
     or (v_charge.billing_type = 'CREDIT_CARD' and v_installment is not null
         and v_charge.asaas_installment_id = v_installment) then
    update public.pix_charges
       set asaas_payment_id = coalesce(asaas_payment_id, p_payment),
           pix_payload = coalesce(pix_payload, nullif(btrim(p_payload), '')),
           asaas_installment_id = coalesce(asaas_installment_id, v_installment),
           card_brand = coalesce(card_brand, v_brand),
           card_last4 = coalesce(card_last4, v_last4)
     where id = v_charge.id;
    return true;
  end if;
  return false;
end
$$;

-- 3) nfse_charge_by_payment: o parâmetro novo muda a assinatura, então a função é recriada (042 não é editada).
drop function nfse_charge_by_payment(text);
create function nfse_charge_by_payment(p_asaas_payment_id text, p_installment text default null)
returns table (charge_id uuid, amount numeric, asaas_invoice_id text, asaas_installment_id text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, coalesce(c.total_charged, c.amount), c.asaas_invoice_id, c.asaas_installment_id
    from public.pix_charges c
   where (c.asaas_payment_id = p_asaas_payment_id
          or (p_installment is not null and c.asaas_installment_id = p_installment))
     and c.status = 'paid'
   order by (c.asaas_payment_id = p_asaas_payment_id) desc
   limit 1
$$;
alter function nfse_charge_by_payment(text, text) owner to auth_profile_lookup;
revoke all on function nfse_charge_by_payment(text, text) from public, app_runtime;
grant execute on function nfse_charge_by_payment(text, text) to app_webhook;

-- 4) IP de origem da tentativa de cartão (nulo nas linhas antigas e no Pix) e os índices das duas contagens.
alter table pix_charges add column request_ip text check (request_ip is null or length(request_ip) <= 45);
grant insert (request_ip) on pix_charges to app_runtime;
create index pix_charges_card_ip_idx on pix_charges(request_ip, created_at desc)
  where billing_type = 'CREDIT_CARD';
create index pix_charges_card_bureau_idx on pix_charges(bureau_id, created_at desc)
  where billing_type = 'CREDIT_CARD';

-- As contagens precisam enxergar linhas de outros usuários do mesmo IP ou Bureau, que a RLS esconde de app_runtime.
-- Por isso são SECURITY DEFINER (auth_profile_lookup lê pix_charges pela política de gateway) e devolvem só um
-- inteiro: nenhuma linha, id ou IP sai. Exigem sessão; a contagem por Bureau só aceita o Bureau da própria sessão.
create function count_recent_card_attempts_by_ip(p_ip text, p_since timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.app_context_present() or public.app_user_id() is null then
    raise exception 'no session' using errcode = '42501';
  end if;
  if p_ip is null or btrim(p_ip) = '' or p_since is null then
    return 0;
  end if;
  return (select count(*)::int from public.pix_charges
           where request_ip = p_ip and billing_type = 'CREDIT_CARD' and created_at > p_since);
end
$$;
alter function count_recent_card_attempts_by_ip(text, timestamptz) owner to auth_profile_lookup;
revoke all on function count_recent_card_attempts_by_ip(text, timestamptz) from public;
grant execute on function count_recent_card_attempts_by_ip(text, timestamptz) to app_runtime;

create function count_recent_card_attempts_by_bureau(p_bureau_id uuid, p_since timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.app_context_present() or public.app_user_id() is null
     or p_bureau_id is distinct from public.app_bureau_id() then
    raise exception 'no session for this bureau' using errcode = '42501';
  end if;
  if p_since is null then
    return 0;
  end if;
  return (select count(*)::int from public.pix_charges
           where bureau_id = p_bureau_id and billing_type = 'CREDIT_CARD' and created_at > p_since);
end
$$;
alter function count_recent_card_attempts_by_bureau(uuid, timestamptz) owner to auth_profile_lookup;
revoke all on function count_recent_card_attempts_by_bureau(uuid, timestamptz) from public;
grant execute on function count_recent_card_attempts_by_bureau(uuid, timestamptz) to app_runtime;
