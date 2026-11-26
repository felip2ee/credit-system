-- Cadastro sem e-mail de confirmação.
-- register_client não cria mais o desafio de e-mail nem a notificação: o usuário nasce com email_verified = false.
-- request_phone_verification não exige mais o e-mail verificado.
-- request_email_verification e confirm_email_verification ficam como estão, para os links já enviados.
-- Mesma assinatura das duas funções (026 e 021): dono, revoke e grant não mudam.
-- shortcut: p_email_token e p_site_url de register_client ficam sem uso; remover em migration futura se atrapalharem.

create or replace function register_client(
  p_slug text,
  p_type text,
  p_name text,
  p_document_digits text,
  p_email text,
  p_phone_e164 text,
  p_password_hash text,
  p_terms_version integer,
  p_privacy_version integer,
  p_ip inet,
  p_user_agent text,
  p_email_token text,
  p_site_url text,
  p_referral_code text default null
)
returns table (ok boolean, reason text, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid;
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_name);
  v_id uuid := gen_random_uuid();
  v_aff record;
  -- IPv6 é agrupado por /64: um cliente tem o prefixo inteiro, não um endereço.
  v_bucket inet := case when family(p_ip) = 6 then network(set_masklen(p_ip, 64)) else p_ip end;
begin
  -- LimitByIp: toda chamada conta, com sucesso ou não. A linha fica mesmo com ok = false.
  perform pg_advisory_xact_lock(hashtextextended('client_register:' || coalesce(host(v_bucket), '-'), 0));
  delete from public.client_register_attempts where created_at < now() - interval '1 day';
  if (select count(*) from public.client_register_attempts a
       where a.ip is not distinct from v_bucket and a.created_at > now() - interval '1 hour') >= 10 then
    return query select false, 'rate_limited'::text, null::uuid;
    return;
  end if;
  insert into public.client_register_attempts (ip) values (v_bucket);

  if p_type is null or p_type not in ('PF', 'PJ')
     or p_document_digits is null
     or p_document_digits !~ (case p_type when 'PF' then '^[0-9]{11}$' else '^[0-9]{14}$' end)
     or v_name is null or length(v_name) not between 2 and 120
     or v_email is null or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$'
     or p_password_hash is null or length(p_password_hash) < 20
     or (p_user_agent is not null and length(p_user_agent) > 512) then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  select b.id into v_bureau from public.bureaus b where b.slug = p_slug and b.status = 'active';
  if not found then
    return query select false, 'bureau_not_found'::text, null::uuid;
    return;
  end if;

  if p_terms_version is distinct from public.legal_current_version('terms')
     or p_privacy_version is distinct from public.legal_current_version('privacy') then
    return query select false, 'outdated_terms'::text, null::uuid;
    return;
  end if;

  -- D3: Titular do mesmo documento no Bureau, ligado ou não a uma conta. O operador liga pelo convite.
  perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || p_document_digits, 0));
  if exists (select 1 from public.holders h where h.bureau_id = v_bureau and h.document_digits = p_document_digits) then
    return query select false, 'document_in_use'::text, null::uuid;
    return;
  end if;

  insert into public."user" (id, name, email, email_verified)
  values (v_id::text, v_name, v_email, false)
  on conflict ((lower(email))) do nothing;
  if not found then
    return query select false, 'email_in_use'::text, null::uuid;
    return;
  end if;

  insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
  values (gen_random_uuid()::text, 'local:credential', v_id::text, 'credential', v_id::text, p_password_hash, now());
  -- O trigger profiles_create_client_wallet (015) cria a carteira zerada.
  insert into public.profiles (id, auth_user_id, full_name, email, role, bureau_id, phone_e164)
  values (v_id, v_id::text, v_name, v_email, 'client', v_bureau, p_phone_e164);
  insert into public.holders (bureau_id, type, name, document, email, phone, client_profile_id, created_by)
  values (v_bureau, p_type::public.query_type, v_name, p_document_digits, v_email, p_phone_e164, v_id, v_id);
  insert into public.legal_acceptances (profile_id, document_id, ip, user_agent)
  select v_id, d.id, p_ip, p_user_agent
    from public.legal_documents d
   where (d.kind = 'terms' and d.version = p_terms_version)
      or (d.kind = 'privacy' and d.version = p_privacy_version);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata, ip_address, user_agent)
  values (v_bureau, v_id, 'client.register', 'profiles', v_id, jsonb_build_object('type', p_type), p_ip, p_user_agent);

  -- Indicação: código inválido, de outro Bureau, de conta anonimizada ou autoindicação é ignorado, sem erro.
  if p_referral_code ~ '^[a-z0-9]{8}$' then
    select c.profile_id, p.email, p.phone_e164 into v_aff
      from public.affiliate_codes c
      join public.profiles p on p.id = c.profile_id
     where c.code = p_referral_code and c.bureau_id = v_bureau and p.anonymized_at is null;
    if found
       and lower(v_aff.email) is distinct from v_email
       and v_aff.phone_e164 is distinct from p_phone_e164
       and not exists (select 1 from public.holders h
                        where h.client_profile_id = v_aff.profile_id and h.document_digits = p_document_digits) then
      insert into public.affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id)
      values (v_id, v_aff.profile_id, v_bureau);
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_bureau, v_id, 'affiliate.referral_linked', 'profiles', v_id,
              jsonb_build_object('affiliate_profile_id', v_aff.profile_id));
    end if;
  end if;

  return query select true, null::text, v_id;
end
$$;

create or replace function request_phone_verification(p_user_id uuid, p_phone_e164 text, p_code text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_p record;
  v_changed boolean;
  v_id uuid;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  -- Só celular brasileiro: o código sai por WhatsApp pago e o destino é livre.
  if p_phone_e164 is null or p_phone_e164 !~ '^\+55[1-9][0-9]9[0-9]{8}$'
     or p_code is null or p_code !~ '^[0-9]{6}$' then
    return query select false, 'invalid_input'::text;
    return;
  end if;
  select p.bureau_id, p.phone_e164, p.phone_verified_at
    into v_p
    from public.profiles p
   where p.id = p_user_id and p.role = 'client' and p.bureau_id = public.app_bureau_id()
   for update of p;
  if not found then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  v_changed := v_p.phone_e164 is distinct from p_phone_e164;
  if not v_changed and v_p.phone_verified_at is not null then
    return query select false, 'already_verified'::text;
    return;
  end if;

  -- Recusa antes de mudar o telefone: pedido recusado não muda nada.
  if exists (select 1 from public.verification_challenges c
              where c.profile_id = p_user_id and c.kind = 'phone'
                and c.created_at > now() - interval '60 seconds') then
    return query select false, 'cooldown'::text;
    return;
  end if;
  if (select count(*) from public.verification_challenges c
       where c.profile_id = p_user_id and c.kind = 'phone'
         and c.created_at > now() - interval '1 hour') >= 5 then
    return query select false, 'too_many'::text;
    return;
  end if;
  -- Teto por número, em todos os perfis: ninguém usa o WhatsApp para spam de um destino.
  if (select count(*) from public.verification_challenges c
       where c.kind = 'phone' and c.target = p_phone_e164
         and c.created_at > now() - interval '1 hour') >= 5 then
    return query select false, 'too_many'::text;
    return;
  end if;

  if v_changed then
    update public.profiles
       set phone_e164 = p_phone_e164, phone_verified_at = null, notification_channel = 'email'
     where id = p_user_id;
  end if;
  update public.verification_challenges set consumed_at = now()
   where profile_id = p_user_id and kind = 'phone' and consumed_at is null;
  insert into public.verification_challenges (profile_id, kind, target, code_hash, expires_at)
  values (p_user_id, 'phone', p_phone_e164, public.account_secret_hash(p_code), now() + interval '10 minutes')
  returning id into v_id;

  perform public.enqueue_system_notification(
    v_p.bureau_id, p_user_id, 'phone_verification', 'whatsapp', p_phone_e164,
    jsonb_build_object('code', p_code), 'phone_verification:' || v_id, 'profile:' || p_user_id);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_p.bureau_id, p_user_id, 'client.phone_verification_requested', 'profiles', p_user_id,
          jsonb_build_object('phoneChanged', v_changed));
  return query select true, null::text;
end
$$;
