-- Revisão de segurança do afiliado entre bureaus (plano afiliado-bureaus).
-- 1) Mudar o modo ou o walletId do afiliado avisa o afiliado por e-mail, na mesma transação, qualquer que seja o autor.
--    Se o aviso não entra na fila, a mudança é desfeita. Só o walletId mascarado (4 últimos) sai do banco.
-- 2) O walletId do afiliado não pode ser o de um sócio ou de um bureau ('affiliate_wallet_reserved').
-- 3) charge_split_mark_refused: o Asaas recusou o split na criação e a cobrança segue sem ele; as linhas asaas
--    pendentes viram refused.
-- 4) lgpd_anonymize_client_account (040): também apaga o walletId do afiliado e volta o modo para pix.

-- 1) Aviso.
insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
values (
  'affiliate_payout_changed', 'email', 1, array['clientName', 'actor', 'method', 'wallet'],
  'O pagamento da sua comissão mudou',
  $html$<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#F4EAD7;font-family:Arial, sans-serif;color:#123029;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4EAD7;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;max-width:560px;width:100%;border-top:6px solid #CFA968;">
          <tr><td style="background:#FBF8F2;text-align:center;padding:24px;">
            <img src="{{siteUrl}}/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png" alt="Rainha Cred" width="200" style="display:inline-block;width:200px;max-width:100%;height:auto;border:0;">
          </td></tr>
          <tr><td style="padding:28px 24px 0;text-align:center;">
            <h1 style="margin:0;font-family:Arial, sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:#0A3329;">O pagamento da sua comissão mudou</h1>
          </td></tr>
          <tr><td style="padding:16px 24px 28px;text-align:center;font-family:Arial, sans-serif;font-size:18px;line-height:1.5;color:#123029;">
            <p style="margin:0 0 16px;">Olá, {{clientName}}. O recebimento da sua comissão de afiliado mudou.</p>
            <p style="margin:0 0 16px;">Quem alterou: {{actor}}.<br/>Forma de recebimento: {{method}}<br/>walletId: {{wallet}}</p>
            <p style="margin:0;font-weight:700;">Se você não esperava esta mudança, fale com o seu bureau agora.</p>
          </td></tr>
          <tr><td style="background:#05261F;padding:18px 24px;text-align:center;font-family:Arial, sans-serif;font-size:14px;line-height:1.5;color:#F4EAD7;">
            Rainha Cred · suporte@rainhacred.com.br
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>$html$,
  $text$Olá, {{clientName}}.

O recebimento da sua comissão de afiliado mudou.
Quem alterou: {{actor}}.
Forma de recebimento: {{method}}
walletId: {{wallet}}

Se você não esperava esta mudança, fale com o seu bureau agora.

Rainha Cred · suporte@rainhacred.com.br$text$
)
on conflict do nothing;

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
      'actor', case when public.app_user_id() = new.profile_id then 'você' else 'a equipe do bureau' end,
      'method', case new.payout_method when 'asaas' then 'Conta Asaas' else 'Chave Pix' end,
      'wallet', coalesce('***' || right(new.asaas_wallet_id, 4), 'nenhum')),
    'affiliate_payout_changed:' || gen_random_uuid(), 'affiliate_payout:' || new.profile_id);
  return null;
end
$$;

create or replace trigger affiliate_wallets_payout_changed
  after update of payout_method, asaas_wallet_id on affiliate_wallets
  for each row
  when (old.payout_method is distinct from new.payout_method or old.asaas_wallet_id is distinct from new.asaas_wallet_id)
  execute function affiliate_payout_changed_notify();

-- 2) walletId reservado. Definer: o afiliado não lê sócios nem walletId de bureau.
create or replace function affiliate_wallet_not_reserved()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from public.platform_partners p where lower(p.asaas_wallet_id) = lower(new.asaas_wallet_id))
     or exists (select 1 from public.bureau_asaas_wallets b where lower(b.asaas_wallet_id) = lower(new.asaas_wallet_id)) then
    raise exception 'affiliate_wallet_reserved' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create or replace trigger affiliate_wallets_wallet_reserved
  before update of payout_method, asaas_wallet_id on affiliate_wallets
  for each row
  when (new.asaas_wallet_id is not null
        and (new.asaas_wallet_id is distinct from old.asaas_wallet_id
             or (new.payout_method = 'asaas' and old.payout_method <> 'asaas')))
  execute function affiliate_wallet_not_reserved();

-- 3) Split recusado na criação. Só quem cria a cobrança: a sessão autora (checkout) ou, sem sessão, o link de pagamento.
-- Só cobrança recente (a criação leva segundos; 'paid' cobre o webhook que chega antes) e só linha asaas pendente que o
-- Asaas nunca confirmou (sem splitId). A auditoria usa a política charge_split.refused da 072.
create or replace function charge_split_mark_refused(p_charge_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_line public.charge_splits;
  v_count integer := 0;
begin
  if not exists (
    select 1 from public.pix_charges c
     where c.id = p_charge_id and c.status in ('pending', 'paid') and c.created_at > now() - interval '1 hour'
       and case when public.app_context_present()
                then c.payment_link_id is null and c.bureau_id = public.app_bureau_id()
                     and c.requested_by = public.app_user_id()
                else c.payment_link_id is not null
           end) then
    raise exception 'not_allowed' using errcode = 'insufficient_privilege';
  end if;

  for v_line in
    update public.charge_splits set status = 'refused'
     where pix_charge_id = p_charge_id and payout_method = 'asaas' and status = 'pending' and asaas_split_id is null
    returning *
  loop
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (
      case when v_line.beneficiary_kind = 'partner' then null else v_line.bureau_id end,
      null, 'charge_split.refused', 'charge_splits', v_line.id,
      jsonb_build_object(
        'pix_charge_id', p_charge_id,
        'beneficiary_kind', v_line.beneficiary_kind,
        'from_status', 'pending',
        'reason', 'split_rejected_on_charge',
        'wallet', '***' || right(v_line.asaas_wallet_id, 4)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

alter function affiliate_payout_changed_notify() owner to auth_profile_lookup;
alter function affiliate_wallet_not_reserved() owner to auth_profile_lookup;
alter function charge_split_mark_refused(uuid) owner to auth_profile_lookup;
revoke all on function affiliate_payout_changed_notify() from public;
revoke all on function affiliate_wallet_not_reserved() from public;
revoke all on function charge_split_mark_refused(uuid) from public;
grant execute on function charge_split_mark_refused(uuid) to app_runtime;

-- 4) LGPD. Corpo da 040; só o update de affiliate_wallets é novo (depois do profiles: anonimizado não recebe aviso).
-- Dono (lgpd_owner) e grants da função não mudam.
grant update (payout_method, asaas_wallet_id) on affiliate_wallets to lgpd_owner;
drop policy if exists affiliate_wallets_lgpd_update on affiliate_wallets;
create policy affiliate_wallets_lgpd_update on affiliate_wallets for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());

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
   for no key update;
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
              where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.available > 0)
     or exists (select 1 from public.affiliate_withdrawals w
                 where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.status = 'open') then
    return 'commission';
  end if;
  if exists (select 1 from public.dossier_orders o
              where o.client_profile_id = p_profile_id and o.bureau_id = v_bureau
                and o.state not in ('completed', 'released', 'cancelled', 'failed')) then
    return 'open_orders';
  end if;
  -- Última checagem, já sob a trava da carteira do afiliado: perde a comissão pendente ou devolve 'commission'.
  if not public.affiliate_forfeit_pending(p_profile_id) then
    return 'commission';
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
  -- Dados de pagamento do dono (documento, CEP e número cifrados).
  delete from public.payer_profiles where client_profile_id = p_profile_id and bureau_id = v_bureau;
  -- walletId do Asaas identifica a conta da pessoa. O histórico (charge_splits) fica.
  update public.affiliate_wallets set payout_method = 'pix', asaas_wallet_id = null
   where profile_id = p_profile_id and bureau_id = v_bureau;
  return 'ok';
end
$$;
