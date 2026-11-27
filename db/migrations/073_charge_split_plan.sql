-- Plano de split de cada cobrança Asaas (plano afiliado-bureaus, parte 1, task 3).
-- 1) charge_split_plan_internal(charge): calcula as camadas e grava charge_splits (pending). Interna, sem grant.
--    Camadas: sócios ativos, bureau dono do cliente, bureau indicador ativo e afiliado de link. Tudo sai do banco a partir
--    da cobrança (bureau, cliente): quem chama não escolhe beneficiário, walletId, percentual nem valor.
--    Cobrança de recarga do próprio bureau (sem cliente e sem link): só os sócios (C1).
--    Base: valor da recarga em centavos (pix_charges.amount). A taxa do Asaas é repassada ao pagador (045 e cartão), então o
--    valor líquido do Asaas é próximo da recarga; o Asaas aplica o percentual sobre o líquido dele. amount_cents é a estimativa.
--    Soma dos percentuais acima de 100 lança 'split_over_100' (a transação desfaz tudo). A sobra de arredondamento fica
--    com a plataforma (floor por linha). Linha de valor zero não é gravada.
--    Cobrança já ligada ao Asaas (asaas_payment_id) não recalcula: devolve o plano gravado (mudar walletId ou modo depois
--    não altera a cobrança já criada).
-- 2) charge_split_plan(charge): porta da sessão (checkout de recarga). Só o autor da cobrança pendente do próprio bureau.
-- 3) payment_link_charge_split(charge): porta do link de pagamento (sem sessão). Só cobrança de link pendente e sem Asaas.
-- 4) Carência da comissão sobre a entrada: chave própria affiliate_cash_in_hold_days (padrão 0). A chave antiga
--    affiliate_commission_hold_days (semente 30, 026) fica só para a comissão da captura do pedido.

insert into settings (key, value, description) values
  ('affiliate_cash_in_hold_days', '0'::jsonb, 'Dias de carência da comissão do afiliado sobre a entrada de dinheiro (modo Pix) antes de ficar disponível')
on conflict (key) do nothing;

alter table settings add constraint settings_affiliate_cash_in_hold_days_check check (
  key <> 'affiliate_cash_in_hold_days'
  or case
       when jsonb_typeof(value) = 'number'
         then (value #>> '{}')::numeric between 0 and 3650
              and (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
       else false
     end
);

create policy settings_gateway_cash_in_hold on settings for select to auth_profile_lookup
  using (key = 'affiliate_cash_in_hold_days');

-- Colunas que as funções abaixo leem (a 027 deu só bureau_id e default_pct).
grant select (affiliate_enabled) on bureau_affiliate_settings to auth_profile_lookup;
grant select (profile_id, bureau_id, payout_method, asaas_wallet_id) on affiliate_wallets to auth_profile_lookup;

-- Auditoria do plano: sem sessão (user_id nulo), sobre a cobrança do mesmo bureau. O metadata leva o walletId mascarado.
create policy audit_logs_charge_split_plan_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'charge_split.planned'
  and support_session_id is null
  and user_id is null
  and table_name = 'pix_charges'
  and bureau_id is not null
  and exists (select 1 from pix_charges c where c.id = audit_logs.record_id and c.bureau_id = audit_logs.bureau_id)
);

create function charge_split_plan_internal(p_charge_id uuid)
returns table (
  beneficiary_kind text,
  beneficiary_id uuid,
  payout_method text,
  asaas_wallet_id text,
  pct numeric,
  amount_cents bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_charge public.pix_charges;
  v_net bigint;
  v_topup boolean;
  v_total numeric;
  v_inserted integer;
begin
  -- A trava da cobrança serializa duas chamadas: a segunda vê as linhas da primeira.
  select * into v_charge from public.pix_charges where id = p_charge_id for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'no_data_found';
  end if;

  if v_charge.asaas_payment_id is null
     and not exists (select 1 from public.charge_splits s where s.pix_charge_id = p_charge_id) then
    v_net := round(v_charge.amount * 100)::bigint;
    v_topup := v_charge.client_profile_id is null and v_charge.payment_link_id is null;

    with cand as (
      select 'partner'::text as k, p.id as bid, 'asaas'::text as m, p.asaas_wallet_id as w, p.pct as pct
        from public.platform_partners p
       where p.active
      union all
      select 'bureau', v_charge.bureau_id,
             case when bw.asaas_wallet_id is null then 'accrual' else 'asaas' end, bw.asaas_wallet_id,
             public.resolve_bureau_commission_pct(v_charge.bureau_id)
        from (select 1) one
        left join public.bureau_asaas_wallets bw on bw.bureau_id = v_charge.bureau_id
       where not v_topup
      union all
      select 'bureau_referrer', r.referrer_bureau_id,
             case when rw.asaas_wallet_id is null then 'accrual' else 'asaas' end, rw.asaas_wallet_id, r.pct
        from public.bureau_referrals r
        left join public.bureau_asaas_wallets rw on rw.bureau_id = r.referrer_bureau_id
       where not v_topup and r.referred_bureau_id = v_charge.bureau_id and r.active
      union all
      -- Afiliado de link: o mesmo filtro da captura (019/027): afiliado ativo e não anonimizado, indicado com telefone
      -- verificado. Só com o recurso ligado no bureau (affiliate_enabled).
      select 'affiliate', ar.affiliate_profile_id, aw.payout_method,
             case when aw.payout_method = 'asaas' then aw.asaas_wallet_id end,
             coalesce(rt.pct, st.default_pct, 0)
        from public.affiliate_referrals ar
        join public.profiles a on a.id = ar.affiliate_profile_id and a.anonymized_at is null and a.is_active
        join public.profiles b on b.id = ar.referred_profile_id and b.phone_verified_at is not null
        join public.affiliate_wallets aw on aw.profile_id = ar.affiliate_profile_id
        join public.bureau_affiliate_settings st on st.bureau_id = v_charge.bureau_id and st.affiliate_enabled
        left join public.affiliate_rates rt
          on rt.bureau_id = v_charge.bureau_id and rt.affiliate_profile_id = ar.affiliate_profile_id
       where not v_topup and ar.referred_profile_id = v_charge.client_profile_id
         and ar.bureau_id = v_charge.bureau_id
    )
    insert into public.charge_splits
      (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents)
    select p_charge_id, v_charge.bureau_id, cand.k, cand.bid, cand.m, cand.w, cand.pct,
           floor(v_net * cand.pct / 100)::bigint
      from cand
     where coalesce(cand.pct, 0) > 0 and floor(v_net * cand.pct / 100) > 0
    on conflict do nothing;
    get diagnostics v_inserted = row_count;

    select coalesce(sum(s.pct), 0) into v_total from public.charge_splits s where s.pix_charge_id = p_charge_id;
    if v_total > 100 then
      raise exception 'split_over_100' using errcode = 'check_violation';
    end if;

    if v_inserted > 0 then
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      select v_charge.bureau_id, null, 'charge_split.planned', 'pix_charges', p_charge_id,
             jsonb_build_object(
               'net_cents', v_net,
               'payer', case when v_topup then 'bureau' else 'client' end,
               'lines', jsonb_agg(jsonb_build_object(
                 'kind', s.beneficiary_kind, 'method', s.payout_method, 'pct', s.pct::text,
                 'amount_cents', s.amount_cents,
                 'wallet', case when s.asaas_wallet_id is null then null else '***' || right(s.asaas_wallet_id, 4) end)
                 order by s.beneficiary_kind, s.id))
        from public.charge_splits s where s.pix_charge_id = p_charge_id;
    end if;
  end if;

  return query
    select s.beneficiary_kind, s.beneficiary_id, s.payout_method, s.asaas_wallet_id, s.pct, s.amount_cents
      from public.charge_splits s
     where s.pix_charge_id = p_charge_id
     order by s.beneficiary_kind, s.created_at, s.id;
end
$$;

-- Sessão do checkout de recarga: só o autor da cobrança pendente do próprio bureau.
create function charge_split_plan(p_charge_id uuid)
returns table (
  beneficiary_kind text,
  beneficiary_id uuid,
  payout_method text,
  asaas_wallet_id text,
  pct numeric,
  amount_cents bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.app_context_present() or not exists (
    select 1 from public.pix_charges c
     where c.id = p_charge_id and c.bureau_id = public.app_bureau_id() and c.requested_by = public.app_user_id()
       and c.status = 'pending' and c.payment_link_id is null) then
    raise exception 'not_allowed' using errcode = 'insufficient_privilege';
  end if;
  return query select * from public.charge_split_plan_internal(p_charge_id);
end
$$;

-- Link de pagamento (sem sessão): só cobrança de link pendente e ainda sem Asaas, como payment_link_charge_bind.
create function payment_link_charge_split(p_charge_id uuid)
returns table (
  beneficiary_kind text,
  beneficiary_id uuid,
  payout_method text,
  asaas_wallet_id text,
  pct numeric,
  amount_cents bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.pix_charges c
     where c.id = p_charge_id and c.payment_link_id is not null and c.status = 'pending'
       and c.asaas_payment_id is null) then
    raise exception 'not_allowed' using errcode = 'insufficient_privilege';
  end if;
  return query select * from public.charge_split_plan_internal(p_charge_id);
end
$$;

alter function charge_split_plan_internal(uuid) owner to auth_profile_lookup;
alter function charge_split_plan(uuid) owner to auth_profile_lookup;
alter function payment_link_charge_split(uuid) owner to auth_profile_lookup;
revoke all on function charge_split_plan_internal(uuid) from public, app_runtime;
revoke all on function charge_split_plan(uuid) from public;
revoke all on function payment_link_charge_split(uuid) from public;
grant execute on function charge_split_plan(uuid) to app_runtime;
grant execute on function payment_link_charge_split(uuid) to app_runtime;
