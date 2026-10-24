-- Programa de afiliados, comissão.
-- 1) capture_order (019) grava a comissão do afiliado quando o comprador indicado tem telefone verificado; o repasse ao
--    Bureau (accrual) fica com a margem menos a comissão.
-- 2) apply_asaas_payment (019): no estorno de PIX, a falta reverte primeiro a comissão ainda pendente do indicado (da
--    mais nova para a mais antiga) e só o que sobra é cobrado do Bureau (clawback). Comissão já liberada não é tocada.
-- 3) release_due_commissions: passa a comissão vencida da carência de pending para available (só a plataforma chama).
-- 4) lgpd_anonymize_client_account (023): recusa anonimizar conta com saldo de comissão (a 028 troca esta versão).
-- Ordem de travas: liquidação -> carteira do cliente -> carteira do afiliado -> comissões (a captura e o estorno seguem
-- esta ordem; release_due_commissions trava a carteira do afiliado antes das comissões dele). O lock payout:<bureau>
-- do webhook vem depois das comissões, só para o clawback.

-- Dono das funções de captura e webhook: o que elas leem e escrevem sobre afiliados, e só sob as políticas abaixo.
grant select (bureau_id, affiliate_profile_id, pct) on affiliate_rates to auth_profile_lookup;
grant select (bureau_id, default_pct) on bureau_affiliate_settings to auth_profile_lookup;
grant select (key, value) on settings to auth_profile_lookup;
grant insert, update (reversed_amount, status) on affiliate_commissions to auth_profile_lookup;

create policy affiliate_rates_gateway_select on affiliate_rates for select to auth_profile_lookup using (true);
create policy bureau_affiliate_settings_gateway_select on bureau_affiliate_settings for select to auth_profile_lookup
  using (true);
create policy settings_gateway_affiliate_hold on settings for select to auth_profile_lookup
  using (key = 'affiliate_commission_hold_days');
create policy affiliate_commissions_gateway_insert on affiliate_commissions for insert to auth_profile_lookup
  with check (status = 'pending' and reversed_amount = 0);
create policy affiliate_commissions_gateway_update on affiliate_commissions for update to auth_profile_lookup
  using (status = 'pending') with check (status in ('pending', 'released', 'reversed'));

-- Auditoria da comissão: só estas ações, só sobre uma comissão do mesmo Bureau. O metadata não leva documento.
create policy audit_logs_affiliate_commission_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('affiliate.commission', 'affiliate.commission_reversal', 'affiliate.commission_release', 'affiliate.forfeit')
  and table_name = 'affiliate_commissions'
  and support_session_id is null
  and bureau_id is not null
  and exists (
    select 1 from affiliate_commissions c
     where c.id = audit_logs.record_id and c.bureau_id = audit_logs.bureau_id)
);

-- A LGPD lê o saldo de comissão do Bureau do contexto.
grant select (profile_id, bureau_id, pending, available) on public.affiliate_wallets to lgpd_owner;
create policy affiliate_wallets_lgpd_select on affiliate_wallets for select to lgpd_owner
  using (bureau_id = app_bureau_id());

-- 1) Captura (019). Muda só o accrual do ramo online e a comissão.
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
  v_margin numeric;
  v_commission numeric;
  v_affiliate uuid;
  v_pct numeric;
  v_hold_days integer;
  v_commission_id uuid;
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

    -- Comissão: só se o indicado tem telefone verificado e o afiliado está ativo e não foi anonimizado. A % vale na
    -- captura e fica gravada na comissão: mudá-la depois não altera o passado. O perfil do afiliado é lido com
    -- "for share": a anonimização (que o trava "for no key update") e esta captura se enfileiram, e a comissão nunca nasce
    -- depois de a conta ser anonimizada.
    v_margin := v_s.price - v_s.cost;
    v_commission := 0;
    select r.affiliate_profile_id into v_affiliate
      from public.affiliate_referrals r
      join public.profiles a on a.id = r.affiliate_profile_id
      join public.profiles b on b.id = r.referred_profile_id
     where r.referred_profile_id = v_s.client_profile_id
       and a.anonymized_at is null and a.is_active and b.phone_verified_at is not null
       for share of a;
    if v_affiliate is not null and v_margin > 0 then
      v_pct := coalesce(
        (select pct from public.affiliate_rates where bureau_id = v_s.bureau_id and affiliate_profile_id = v_affiliate),
        (select default_pct from public.bureau_affiliate_settings where bureau_id = v_s.bureau_id), 0);
      v_commission := round(v_pct * v_margin / 100, 2);
    end if;
    if v_margin - v_commission > 0 then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
      values (v_s.bureau_id, 'accrual', v_margin - v_commission, v_s.order_ref);
    end if;
    if v_commission > 0 then
      select greatest(floor((value #>> '{}')::numeric)::integer, 0) into v_hold_days
        from public.settings where key = 'affiliate_commission_hold_days' and jsonb_typeof(value) = 'number';
      insert into public.affiliate_commissions
        (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, release_at)
      values
        (v_s.order_ref, v_s.bureau_id, v_affiliate, v_s.client_profile_id, v_pct, v_margin, v_commission,
         now() + make_interval(days => coalesce(v_hold_days, 30)))
      returning id into v_commission_id;
      -- O livro do afiliado não guarda o id do indicado: created_by é o próprio afiliado e a referência é a comissão.
      select * into v_post from public.affiliate_wallet_post_entry(
        v_affiliate, 'commission', v_commission, 'order:commission:' || p_order_ref::text,
        'commission:' || v_commission_id::text, v_affiliate);
      if not v_post.ok then
        raise exception 'affiliate commission failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_s.bureau_id, v_user, 'affiliate.commission', 'affiliate_commissions', v_commission_id,
        jsonb_build_object('order_ref', v_s.order_ref, 'pct', v_pct::text, 'amount', v_commission::text));
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

-- 2) Webhook (019). Muda só o ramo PAYMENT_REFUNDED: reverte primeiro a comissão pendente, cobra o resto do Bureau
-- (clawback) e grava refund_shortfall com o valor final (depois da reversão de comissão e do clawback).
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
          'commission_reversal', v_commissions_reversed::text));
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

-- 3) Fim da carência. Só a plataforma (tick, sem usuário nem Bureau no contexto) chama. Idempotente: a chave do
-- lançamento é por comissão e o status só sai de pending uma vez. Devolve quantas liberou. Comissão que a carteira
-- recusa fica de fora (aviso no log do banco) e as demais seguem.
-- Ordem de travas: carteira do afiliado -> comissões dele (a mesma do estorno). A carteira trava com skip locked: um
-- afiliado em uso (estorno, saque, conversão) fica para o próximo tick e ninguém espera.
create function release_due_commissions(p_limit integer default 500)
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
      select c.id, c.order_ref, c.bureau_id, c.affiliate_profile_id, c.amount - c.reversed_amount as rest
        from public.affiliate_commissions c
       where c.affiliate_profile_id = v_affiliate and c.status = 'pending' and c.release_at <= now()
       order by c.release_at, c.id
       limit greatest(p_limit, 0) - v_released
         for update skip locked
    loop
      select * into v_post from public.affiliate_wallet_post_entry(
        v_commission.affiliate_profile_id, 'commission_release', v_commission.rest,
        'release:' || v_commission.id::text, 'commission:' || v_commission.id::text,
        v_commission.affiliate_profile_id);
      if not v_post.ok then
        -- Uma comissão sem lastro na carteira (não deveria existir) não trava as outras: fica pending e vai ao log.
        raise warning 'affiliate commission % not released: %', v_commission.id, v_post.reason;
        continue;
      end if;
      update public.affiliate_commissions set status = 'released' where id = v_commission.id;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_commission.bureau_id, v_commission.affiliate_profile_id, 'affiliate.commission_release',
        'affiliate_commissions', v_commission.id, jsonb_build_object('amount', v_commission.rest::text));
      v_released := v_released + 1;
    end loop;
  end loop;
  return v_released;
end
$$;

alter function release_due_commissions(integer) owner to auth_profile_lookup;
revoke all on function release_due_commissions(integer) from public;
grant execute on function release_due_commissions(integer) to app_runtime;

-- 4) LGPD (023): comissão pendente ou disponível bloqueia a anonimização da conta. Dono e grants não mudam.
-- O saque aberto entra com a tabela de saques (028), na tarefa seguinte.
create or replace function public.lgpd_anonymize_client_account(p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bureau uuid := public.app_bureau_id();
  v_user_id text;
  v_old_email text;
  v_anonymized_at timestamptz;
  v_email text := 'anon-' || p_profile_id || '@anonimizado.invalid';
begin
  if v_bureau is null or public.app_user_role() is distinct from 'bureau_admin' then
    return 'not_found';
  end if;

  select p.auth_user_id, p.email, p.anonymized_at into v_user_id, v_old_email, v_anonymized_at
    from public.profiles p
   where p.id = p_profile_id and p.role = 'client' and p.bureau_id = v_bureau
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_anonymized_at is not null then
    return 'already_anonymized';
  end if;
  if exists (select 1 from public.client_wallets w
              where w.client_profile_id = p_profile_id and (w.available <> 0 or w.reserved <> 0)) then
    return 'balance';
  end if;
  if exists (select 1 from public.affiliate_wallets w
              where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.pending + w.available > 0) then
    return 'commission';
  end if;
  if exists (select 1 from public.dossier_orders o
              where o.client_profile_id = p_profile_id and o.bureau_id = v_bureau
                and o.state not in ('completed', 'released', 'cancelled', 'failed')) then
    return 'open_orders';
  end if;

  update public.profiles
     set full_name = 'Conta anonimizada', email = v_email, phone_e164 = null, phone_verified_at = null,
         notification_channel = 'email', is_active = false, anonymized_at = now()
   where id = p_profile_id;
  update public."user" set name = 'Conta anonimizada', email = v_email where id = v_user_id;
  delete from public."session" where user_id = v_user_id;
  delete from public.account where user_id = v_user_id;
  delete from public.two_factor where user_id = v_user_id;
  delete from public.verification where value = v_user_id or lower(identifier) = lower(v_old_email);
  -- target guarda o e-mail ou telefone em texto.
  delete from public.verification_challenges where profile_id = p_profile_id;
  return 'ok';
end
$$;
