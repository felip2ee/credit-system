-- Split recusado na criação: toda parte que sai do split vira valor a pagar por fora (plano afiliado-bureaus).
-- Antes (084) todas as linhas asaas viravam `refused` e record_cash_in_commission não gravava nada para elas.
-- 1) charge_split_mark_refused: a linha do bureau e do bureau indicador vira 'accrual'; a do afiliado vira 'pix' (os
--    dois seguem 'pending' e entram no fluxo normal de pagamento e estorno). A do sócio vira 'refused': não existe
--    repasse manual de sócio no sistema (runbook de operations/affiliates.md). p_affiliate_only: só o item do afiliado
--    saiu. p_switch_affiliate (só com p_affiliate_only): passa o afiliado para o modo Pix, se o walletId ainda é o
--    recusado. Cobrança já paga (webhook antes da marca): grava os valores na mesma transação.
-- 2) affiliate_payout_changed_notify (084): o aviso diz quando a troca foi do sistema.

grant update (payout_method) on charge_splits to auth_profile_lookup;
grant update (payout_method) on affiliate_wallets to auth_profile_lookup;

-- Linha recusada que virou valor a pagar: pix ou accrual com walletId (as do plano nascem sem walletId).
create policy audit_logs_charge_split_manual_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'charge_split.refused'
  and support_session_id is null
  and user_id is null
  and table_name = 'charge_splits'
  and exists (
    select 1 from charge_splits s
     where s.id = audit_logs.record_id and s.status = 'pending' and s.payout_method in ('pix', 'accrual')
       and s.asaas_wallet_id is not null and s.beneficiary_kind <> 'partner' and s.bureau_id = audit_logs.bureau_id
  )
);

create policy audit_logs_affiliate_wallet_rejected_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'affiliate.payout_method_rejected'
  and support_session_id is null
  and user_id is null
  and table_name = 'affiliate_wallets'
  and exists (
    select 1 from affiliate_wallets w
     where w.profile_id = audit_logs.record_id and w.bureau_id = audit_logs.bureau_id and w.payout_method = 'pix')
);

create or replace function affiliate_payout_changed_notify()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_profile record;
begin
  -- Conta anonimizada (a LGPD apaga o walletId) não recebe aviso.
  select p.full_name, p.email into v_profile
    from public.profiles p where p.id = new.profile_id and p.anonymized_at is null;
  if not found then
    return null;
  end if;
  perform public.enqueue_system_notification(
    new.bureau_id, coalesce(public.app_user_id(), new.profile_id), 'affiliate_payout_changed', 'email',
    lower(v_profile.email),
    jsonb_build_object(
      'clientName', v_profile.full_name,
      'actor', case
        when current_setting('app.payout_change_reason', true) = 'wallet_rejected'
          then 'o sistema, porque o Asaas recusou o seu walletId'
        when public.app_user_id() = new.profile_id then 'você'
        else 'a equipe do bureau'
      end,
      'method', case new.payout_method when 'asaas' then 'Conta Asaas' else 'Chave Pix' end,
      'wallet', coalesce('***' || right(new.asaas_wallet_id, 4), 'nenhum')),
    'affiliate_payout_changed:' || gen_random_uuid(), 'affiliate_payout:' || new.profile_id);
  return null;
end
$$;

-- A assinatura de um argumento sai: com os defaults as duas ficariam ambíguas.
drop function charge_split_mark_refused(uuid);

-- Quem chama é o mesmo da 084: a sessão autora (checkout) ou, sem sessão, o link de pagamento; cobrança recente e só
-- linha asaas pendente que o Asaas nunca confirmou (sem splitId).
create function charge_split_mark_refused(
  p_charge_id uuid,
  p_affiliate_only boolean default false,
  p_switch_affiliate boolean default false
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_line public.charge_splits;
  v_method text;
  v_bureau uuid;
  v_count integer := 0;
begin
  -- A trava serializa com apply_asaas_payment: ou o webhook vê as linhas já trocadas, ou esta função vê a cobrança paga.
  select * into v_charge from public.pix_charges c
   where c.id = p_charge_id and c.status in ('pending', 'paid') and c.created_at > now() - interval '1 hour'
     and case when public.app_context_present()
              then c.payment_link_id is null and c.bureau_id = public.app_bureau_id()
                   and c.requested_by = public.app_user_id()
              else c.payment_link_id is not null
         end
     for update;
  if not found then
    raise exception 'not_allowed' using errcode = 'insufficient_privilege';
  end if;

  for v_line in
    select * from public.charge_splits s
     where s.pix_charge_id = p_charge_id and s.payout_method = 'asaas' and s.status = 'pending'
       and s.asaas_split_id is null
       and (not coalesce(p_affiliate_only, false) or s.beneficiary_kind = 'affiliate')
     order by s.beneficiary_id, s.id
       for update
  loop
    v_method := case v_line.beneficiary_kind
      when 'affiliate' then 'pix' when 'bureau' then 'accrual' when 'bureau_referrer' then 'accrual' end;
    update public.charge_splits
       set payout_method = coalesce(v_method, payout_method),
           status = case when v_method is null then 'refused' else status end
     where id = v_line.id;

    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (
      case when v_line.beneficiary_kind = 'partner' then null else v_line.bureau_id end,
      null, 'charge_split.refused', 'charge_splits', v_line.id,
      jsonb_build_object(
        'pix_charge_id', p_charge_id,
        'beneficiary_kind', v_line.beneficiary_kind,
        'from_status', 'pending',
        'reason', 'split_rejected_on_charge',
        'manual_method', v_method,
        'wallet', '***' || right(v_line.asaas_wallet_id, 4)));

    if v_line.beneficiary_kind = 'affiliate' and p_affiliate_only and p_switch_affiliate then
      perform set_config('app.payout_change_reason', 'wallet_rejected', true);
      -- Só se o walletId ainda é o recusado: um walletId salvo depois da cobrança não é sobrescrito.
      update public.affiliate_wallets set payout_method = 'pix'
       where profile_id = v_line.beneficiary_id and payout_method = 'asaas'
         and asaas_wallet_id = v_line.asaas_wallet_id
      returning bureau_id into v_bureau;
      if found then
        insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
        values (v_bureau, null, 'affiliate.payout_method_rejected', 'affiliate_wallets', v_line.beneficiary_id,
          jsonb_build_object('from', 'asaas', 'to', 'pix', 'pix_charge_id', p_charge_id,
            'wallet', '***' || right(v_line.asaas_wallet_id, 4)));
      end if;
      perform set_config('app.payout_change_reason', '', true);
    end if;
    v_count := v_count + 1;
  end loop;

  if v_charge.status = 'paid' then
    perform public.record_cash_in_commission(p_charge_id);
  end if;
  return v_count;
end
$$;

alter function charge_split_mark_refused(uuid, boolean, boolean) owner to auth_profile_lookup;
revoke all on function charge_split_mark_refused(uuid, boolean, boolean) from public;
grant execute on function charge_split_mark_refused(uuid, boolean, boolean) to app_runtime;
