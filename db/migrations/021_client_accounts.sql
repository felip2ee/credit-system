-- M5: contas de cliente. A 001-020 já foram aplicadas e não mudam.
-- Cadastro público (register_client), confirmação de e-mail e de telefone (verification_challenges: só o hash),
-- aceite versionado (legal_documents, legal_acceptances) e canal de notificação (profiles).
-- Toda escrita passa por função SECURITY DEFINER com dono auth_profile_lookup, sob as políticas *_gateway abaixo.
-- app_runtime executa só as funções públicas; enqueue_system_notification e os auxiliares não têm grant.

-- Rotas novas de primeiro nível ficam fora dos slugs, como as outras.
alter table bureaus drop constraint bureaus_slug_not_reserved;
alter table bureaus add constraint bureaus_slug_not_reserved check (slug not in (
  'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'login', 'logout', 'mfa',
  'portal', 'autorizacao-scr', 'superadmin', 'settings', 'reset-password',
  'update-password', 'change-password', 'static', 'www',
  'cadastro', 'termos', 'privacidade'));

alter table profiles
  add column phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column phone_verified_at timestamptz,
  add column notification_channel text not null default 'email' check (notification_channel in ('email', 'whatsapp')),
  add constraint profiles_phone_verified_needs_phone check (phone_verified_at is null or phone_e164 is not null),
  add constraint profiles_whatsapp_needs_verified_phone check (notification_channel = 'email' or phone_verified_at is not null);

-- app_runtime tem UPDATE em toda a tabela (004): estas três colunas mudam só pelas funções da 021.
create function protect_profile_contact()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('auth_profile_lookup', 'schema_owner') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.phone_e164 is not null or new.phone_verified_at is not null or new.notification_channel <> 'email' then
      raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
    end if;
  elsif row(old.phone_e164, old.phone_verified_at, old.notification_channel)
        is distinct from row(new.phone_e164, new.phone_verified_at, new.notification_channel) then
    raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger protect_profile_contact before insert or update on profiles
  for each row execute function protect_profile_contact();

create table legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms', 'privacy')),
  version integer not null check (version > 0),
  title text not null check (length(title) between 1 and 200),
  body_md text not null check (length(body_md) between 1 and 200000),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (kind, version)
);
create trigger legal_documents_immutable before update or delete on legal_documents
  for each row execute function append_only_guard();

create table legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  document_id uuid not null references legal_documents(id),
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  unique (profile_id, document_id)
);
create trigger legal_acceptances_immutable before update or delete on legal_acceptances
  for each row execute function append_only_guard();

create table verification_challenges (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  kind text not null check (kind in ('email', 'phone')),
  -- O e-mail ou o telefone do desafio: a confirmação só vale se ainda for o atual.
  target text not null check (length(target) between 3 and 320),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index verification_challenges_profile_kind_created_idx
  on verification_challenges (profile_id, kind, created_at desc);
-- Token de e-mail tem 256 bits: único. Código de telefone (6 dígitos) repete entre clientes: sem índice único.
create unique index verification_challenges_email_hash_uidx
  on verification_challenges (code_hash) where kind = 'email';

create table client_register_attempts (
  id bigint generated always as identity primary key,
  -- Balde do limite: IPv4 inteiro; IPv6 agrupado por /64.
  ip inet,
  created_at timestamptz not null default now()
);
create index client_register_attempts_ip_created_at_idx on client_register_attempts (ip, created_at);
create index client_register_attempts_created_at_idx on client_register_attempts (created_at);

create function account_secret_hash(p text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Mesma máscara de src/lib/notifications/recipient.ts (maskRecipient).
create function account_mask_recipient(p_channel text, p_recipient text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_channel = 'email' then left(split_part(p_recipient, '@', 1), 1) || '***@' || split_part(p_recipient, '@', 2)
    when p_recipient like '+55%' then '+55' || repeat('*', greatest(length(p_recipient) - 7, 0)) || right(p_recipient, 4)
    else '+' || repeat('*', greatest(length(p_recipient) - 5, 0)) || right(p_recipient, 4)
  end
$$;

create function legal_current_version(p_kind text)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
  select max(d.version) from public.legal_documents d where d.kind = p_kind and d.published_at <= now()
$$;

-- Enfileira sem staff (cadastro anônimo, cliente). Mesmas regras da enqueue_notification (020), mas lança erro:
-- o chamador é uma função da 021 e uma falha aqui desfaz a transação inteira.
create function enqueue_system_notification(
  p_bureau_id uuid,
  p_created_by uuid,
  p_template_key text,
  p_channel text,
  p_recipient text,
  p_params jsonb,
  p_idempotency_key text,
  p_reference text
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_tpl public.notification_templates;
  v_id uuid;
begin
  select * into v_tpl from public.notification_templates
   where key = p_template_key and channel = p_channel and status = 'active';
  if not found then
    raise exception 'notification template % (%) not found', p_template_key, p_channel using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_params) is distinct from 'object'
     or exists (select 1 from jsonb_each(p_params) e where jsonb_typeof(e.value) <> 'string')
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_params) k)
        <> (select coalesce(array_agg(x order by x), '{}') from unnest(v_tpl.params) x) then
    raise exception 'invalid params for template %', p_template_key using errcode = '22023';
  end if;

  insert into public.notifications
    (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
     idempotency_key, reference, created_by)
  values
    (p_bureau_id, v_tpl.id, p_channel, p_recipient, public.account_mask_recipient(p_channel, p_recipient),
     public.notification_recipient_hash(p_recipient), p_params, p_idempotency_key, p_reference, p_created_by)
  returning id into v_id;

  insert into public.notification_events (notification_id, bureau_id, kind) values (v_id, p_bureau_id, 'queued');
  return v_id;
end
$$;

-- Desafio de e-mail + notificação + auditoria. null = criado; senão o motivo.
create function account_issue_email_challenge(p_profile_id uuid, p_token text, p_site_url text)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_p record;
  v_id uuid;
begin
  select p.bureau_id, p.full_name, u.email, u.email_verified
    into v_p
    from public.profiles p
    join public."user" u on u.id = p.auth_user_id
   where p.id = p_profile_id and p.role = 'client'
   for update of p;
  if not found then
    return 'not_allowed';
  end if;
  if v_p.email_verified then
    return 'already_verified';
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
     or p_site_url is null or p_site_url !~ '^https?://[^\s?#]+$' then
    return 'invalid_input';
  end if;
  if exists (select 1 from public.verification_challenges c
              where c.profile_id = p_profile_id and c.kind = 'email'
                and c.created_at > now() - interval '60 seconds') then
    return 'cooldown';
  end if;
  if (select count(*) from public.verification_challenges c
       where c.profile_id = p_profile_id and c.kind = 'email'
         and c.created_at > now() - interval '1 hour') >= 5 then
    return 'too_many';
  end if;

  -- Pedido novo invalida o link anterior.
  update public.verification_challenges set consumed_at = now()
   where profile_id = p_profile_id and kind = 'email' and consumed_at is null;
  insert into public.verification_challenges (profile_id, kind, target, code_hash, expires_at)
  values (p_profile_id, 'email', lower(v_p.email), public.account_secret_hash(p_token), now() + interval '24 hours')
  returning id into v_id;

  perform public.enqueue_system_notification(
    v_p.bureau_id, p_profile_id, 'email_verification', 'email', lower(v_p.email),
    jsonb_build_object('clientName', v_p.full_name,
                       'url', rtrim(p_site_url, '/') || '/cadastro/confirmar-email?token=' || p_token),
    'email_verification:' || v_id, 'profile:' || p_profile_id);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_p.bureau_id, p_profile_id, 'client.email_verification_requested', 'profiles', p_profile_id, '{}');
  return null;
end
$$;

-- Leitura do mesmo limite de register_client, para a ação recusar antes de gastar scrypt. Não grava nada.
create function client_register_ip_allowed(p_ip inet)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*) < 10
    from public.client_register_attempts a
   where a.ip is not distinct from (case when family(p_ip) = 6 then network(set_masklen(p_ip, 64)) else p_ip end)
     and a.created_at > now() - interval '1 hour'
$$;

create function register_client(
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
  p_site_url text
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
  v_reason text;
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

  v_reason := public.account_issue_email_challenge(v_id, p_email_token, p_site_url);
  if v_reason is not null then
    raise exception 'email challenge failed: %', v_reason using errcode = '22023';
  end if;
  return query select true, null::text, v_id;
end
$$;

create function confirm_email_verification(p_token text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_c record;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return query select false, 'invalid'::text;
    return;
  end if;
  select c.id, c.profile_id, c.target, c.expires_at, c.consumed_at, p.bureau_id, p.auth_user_id,
         u.email, u.email_verified
    into v_c
    from public.verification_challenges c
    join public.profiles p on p.id = c.profile_id
    join public."user" u on u.id = p.auth_user_id
   where c.kind = 'email' and c.code_hash = public.account_secret_hash(p_token)
   for update of c;
  if not found then
    return query select false, 'invalid'::text;
    return;
  end if;
  if v_c.consumed_at is not null then
    -- Segundo clique no mesmo link: sucesso só se o e-mail já está confirmado.
    return query select v_c.email_verified, case when v_c.email_verified then null else 'invalid' end::text;
    return;
  end if;
  if v_c.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;
  if lower(v_c.email) <> v_c.target then
    return query select false, 'invalid'::text;
    return;
  end if;

  update public."user" set email_verified = true, updated_at = now() where id = v_c.auth_user_id;
  update public.verification_challenges set consumed_at = now() where id = v_c.id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_c.bureau_id, v_c.profile_id, 'client.email_verified', 'profiles', v_c.profile_id, '{}');
  return query select true, null::text;
end
$$;

-- Os pedidos abaixo exigem o cliente logado (ClientContext): papel client, id igual a p_user_id e Bureau da sessão.
create function request_email_verification(p_user_id uuid, p_token text, p_site_url text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_reason text;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  perform 1 from public.profiles p
   where p.id = p_user_id and p.role = 'client' and p.bureau_id = public.app_bureau_id();
  if not found then
    return query select false, 'not_allowed'::text;
    return;
  end if;

  v_reason := public.account_issue_email_challenge(p_user_id, p_token, p_site_url);
  return query select v_reason is null, v_reason;
end
$$;

create function request_phone_verification(p_user_id uuid, p_phone_e164 text, p_code text)
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
  select p.bureau_id, p.phone_e164, p.phone_verified_at, u.email_verified
    into v_p
    from public.profiles p
    join public."user" u on u.id = p.auth_user_id
   where p.id = p_user_id and p.role = 'client' and p.bureau_id = public.app_bureau_id()
   for update of p;
  if not found then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if not v_p.email_verified then
    return query select false, 'email_not_verified'::text;
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

create function confirm_phone_verification(p_user_id uuid, p_code text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_c record;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    return query select false, 'invalid'::text;
    return;
  end if;
  select c.id, c.target, c.code_hash, c.attempts, c.max_attempts, c.expires_at, p.bureau_id, p.phone_e164
    into v_c
    from public.verification_challenges c
    join public.profiles p on p.id = c.profile_id
   where c.profile_id = p_user_id and c.kind = 'phone' and c.consumed_at is null
     and p.bureau_id = public.app_bureau_id()
   order by c.created_at desc
   limit 1
   for update of c;
  if not found then
    return query select false, 'invalid'::text;
    return;
  end if;
  if v_c.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;
  if v_c.code_hash <> public.account_secret_hash(p_code) or v_c.target is distinct from v_c.phone_e164 then
    -- A tentativa conta mesmo com erro: a função retorna normalmente e a transação faz commit.
    update public.verification_challenges
       set attempts = attempts + 1,
           consumed_at = case when attempts + 1 >= max_attempts then now() end
     where id = v_c.id;
    return query select false,
      case when v_c.attempts + 1 >= v_c.max_attempts then 'too_many_attempts' else 'invalid' end::text;
    return;
  end if;

  update public.verification_challenges set attempts = attempts + 1, consumed_at = now() where id = v_c.id;
  update public.profiles set phone_verified_at = now() where id = p_user_id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_c.bureau_id, p_user_id, 'client.phone_verified', 'profiles', p_user_id, '{}');
  return query select true, null::text;
end
$$;

create function accept_legal_documents(
  p_user_id uuid,
  p_terms_version integer,
  p_privacy_version integer,
  p_ip inet,
  p_user_agent text
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid;
  v_new integer;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  select p.bureau_id into v_bureau from public.profiles p
   where p.id = p_user_id and p.role = 'client' and p.bureau_id = public.app_bureau_id();
  if not found then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_terms_version is distinct from public.legal_current_version('terms')
     or p_privacy_version is distinct from public.legal_current_version('privacy') then
    return query select false, 'outdated'::text;
    return;
  end if;

  insert into public.legal_acceptances (profile_id, document_id, ip, user_agent)
  select p_user_id, d.id, p_ip, left(p_user_agent, 512)
    from public.legal_documents d
   where (d.kind = 'terms' and d.version = p_terms_version)
      or (d.kind = 'privacy' and d.version = p_privacy_version)
  on conflict (profile_id, document_id) do nothing;
  get diagnostics v_new = row_count;
  if v_new > 0 then
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata, ip_address, user_agent)
    values (v_bureau, p_user_id, 'client.legal_accepted', 'profiles', p_user_id,
            jsonb_build_object('termsVersion', p_terms_version, 'privacyVersion', p_privacy_version),
            p_ip, left(p_user_agent, 512));
  end if;
  return query select true, null::text;
end
$$;

create function set_notification_channel(p_user_id uuid, p_channel text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_p record;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    return query select false, 'invalid_input'::text;
    return;
  end if;
  select p.bureau_id, p.phone_verified_at, p.notification_channel
    into v_p
    from public.profiles p
   where p.id = p_user_id and p.role = 'client' and p.bureau_id = public.app_bureau_id()
   for update of p;
  if not found then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_channel = 'whatsapp' and v_p.phone_verified_at is null then
    return query select false, 'phone_not_verified'::text;
    return;
  end if;
  if p_channel = v_p.notification_channel then
    return query select true, null::text;
    return;
  end if;

  update public.profiles set notification_channel = p_channel where id = p_user_id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_p.bureau_id, p_user_id, 'client.notification_channel_set', 'profiles', p_user_id,
          jsonb_build_object('channel', p_channel));
  return query select true, null::text;
end
$$;

alter table legal_documents owner to schema_owner;
alter table legal_acceptances owner to schema_owner;
alter table verification_challenges owner to schema_owner;
alter table client_register_attempts owner to schema_owner;
alter function protect_profile_contact() owner to schema_owner;
alter function account_secret_hash(text) owner to schema_owner;
alter function account_mask_recipient(text, text) owner to schema_owner;
alter function legal_current_version(text) owner to auth_profile_lookup;
alter function enqueue_system_notification(uuid, uuid, text, text, text, jsonb, text, text) owner to auth_profile_lookup;
alter function account_issue_email_challenge(uuid, text, text) owner to auth_profile_lookup;
alter function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text) owner to auth_profile_lookup;
alter function client_register_ip_allowed(inet) owner to auth_profile_lookup;
alter function confirm_email_verification(text) owner to auth_profile_lookup;
alter function request_email_verification(uuid, text, text) owner to auth_profile_lookup;
alter function request_phone_verification(uuid, text, text) owner to auth_profile_lookup;
alter function confirm_phone_verification(uuid, text) owner to auth_profile_lookup;
alter function accept_legal_documents(uuid, integer, integer, inet, text) owner to auth_profile_lookup;
alter function set_notification_channel(uuid, text) owner to auth_profile_lookup;

revoke all on function protect_profile_contact() from public;
revoke all on function account_secret_hash(text) from public;
revoke all on function account_mask_recipient(text, text) from public;
revoke all on function legal_current_version(text) from public;
revoke all on function enqueue_system_notification(uuid, uuid, text, text, text, jsonb, text, text) from public;
revoke all on function account_issue_email_challenge(uuid, text, text) from public;
revoke all on function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text) from public;
revoke all on function client_register_ip_allowed(inet) from public;
revoke all on function confirm_email_verification(text) from public;
revoke all on function request_email_verification(uuid, text, text) from public;
revoke all on function request_phone_verification(uuid, text, text) from public;
revoke all on function confirm_phone_verification(uuid, text) from public;
revoke all on function accept_legal_documents(uuid, integer, integer, inet, text) from public;
revoke all on function set_notification_channel(uuid, text) from public;
grant execute on function account_secret_hash(text) to auth_profile_lookup;
grant execute on function account_mask_recipient(text, text) to auth_profile_lookup;
grant execute on function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text) to app_runtime;
grant execute on function client_register_ip_allowed(inet) to app_runtime;
grant execute on function confirm_email_verification(text) to app_runtime;
grant execute on function request_email_verification(uuid, text, text) to app_runtime;
grant execute on function request_phone_verification(uuid, text, text) to app_runtime;
grant execute on function confirm_phone_verification(uuid, text) to app_runtime;
grant execute on function accept_legal_documents(uuid, integer, integer, inet, text) to app_runtime;
grant execute on function set_notification_channel(uuid, text) to app_runtime;

alter table legal_documents enable row level security;
alter table legal_documents force row level security;
alter table legal_acceptances enable row level security;
alter table legal_acceptances force row level security;
alter table verification_challenges enable row level security;
alter table verification_challenges force row level security;
alter table client_register_attempts enable row level security;
alter table client_register_attempts force row level security;

revoke all on legal_documents, legal_acceptances, verification_challenges, client_register_attempts
  from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
-- Texto público: as páginas /termos e /privacidade leem sem sessão.
grant select on legal_documents to app_runtime;
grant select on legal_acceptances to app_runtime;
grant select on legal_documents, legal_acceptances, verification_challenges, client_register_attempts to backup_reader;

create policy legal_documents_select on legal_documents for select using (true);
create policy legal_acceptances_select_own on legal_acceptances for select
  using (app_context_present() and profile_id = app_user_id());

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select on legal_documents to auth_profile_lookup;
grant select, insert on legal_acceptances to auth_profile_lookup;
grant select, insert, update (attempts, consumed_at) on verification_challenges to auth_profile_lookup;
grant select, insert, delete on client_register_attempts to auth_profile_lookup;
grant select (id, email, email_verified), insert (id, name, email, email_verified),
  update (email_verified, updated_at) on public."user" to auth_profile_lookup;
grant select (full_name, email, phone_e164, phone_verified_at, notification_channel),
  insert (id, auth_user_id, full_name, email, role, bureau_id, phone_e164),
  update (phone_e164, phone_verified_at, notification_channel) on public.profiles to auth_profile_lookup;
grant select (document_digits),
  insert (bureau_id, type, name, document, email, phone, client_profile_id, created_by) on public.holders to auth_profile_lookup;
grant insert (ip_address, user_agent) on public.audit_logs to auth_profile_lookup;

create policy legal_acceptances_gateway_select on legal_acceptances for select to auth_profile_lookup using (true);
create policy legal_acceptances_gateway_insert on legal_acceptances for insert to auth_profile_lookup with check (true);
create policy verification_challenges_gateway_select on verification_challenges for select to auth_profile_lookup using (true);
create policy verification_challenges_gateway_insert on verification_challenges for insert to auth_profile_lookup with check (true);
create policy verification_challenges_gateway_update on verification_challenges for update to auth_profile_lookup
  using (true) with check (true);
create policy client_register_attempts_gateway_select on client_register_attempts for select to auth_profile_lookup using (true);
create policy client_register_attempts_gateway_insert on client_register_attempts for insert to auth_profile_lookup with check (true);
create policy client_register_attempts_gateway_delete on client_register_attempts for delete to auth_profile_lookup using (true);
create policy profiles_gateway_insert on profiles for insert to auth_profile_lookup
  with check (role = 'client' and bureau_id is not null and not must_change_password);
-- profiles_gateway_update (009) cobre só a equipe; admin_set_credentials confere o papel no próprio SQL.
create policy profiles_gateway_update_client on profiles for update to auth_profile_lookup
  using (role = 'client') with check (role = 'client');
create policy holders_gateway_insert on holders for insert to auth_profile_lookup
  with check (client_profile_id is not null and created_by = client_profile_id);
-- Auditoria das funções da 021: só estas ações, só sobre o próprio perfil client do Bureau.
create policy audit_logs_client_account_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('client.register', 'client.email_verification_requested', 'client.email_verified',
             'client.phone_verification_requested', 'client.phone_verified', 'client.legal_accepted',
             'client.notification_channel_set')
  and table_name = 'profiles'
  and record_id = user_id
  and support_session_id is null
  and exists (
    select 1 from profiles p
     where p.id = audit_logs.user_id and p.role = 'client' and p.bureau_id = audit_logs.bureau_id)
);

-- Sementes. Texto provisório: a versão aprovada entra como versão 2 antes de abrir o cadastro ao público.
insert into legal_documents (kind, version, title, body_md) values (
  'terms', 1, 'Termos de Uso',
  $md$> **Texto provisório.** Este texto será substituído pela versão aprovada antes da abertura do cadastro ao público.

## 1. Objeto

Estes termos regem o uso da plataforma de crédito da Rainha do Crédito. Ao criar uma conta, você declara que leu e aceita estas regras.

## 2. Conta

Você informa dados verdadeiros no cadastro e mantém sua senha em sigilo. Você responde pelo que acontece na sua conta. Avise-nos se achar que alguém usou a conta sem sua permissão.

## 3. Dados tratados

Tratamos os dados do cadastro e das consultas que você pede, só para prestar o serviço. A Política de Privacidade explica o uso em detalhes.

## 4. Direitos do titular

Pela LGPD, você pode pedir acesso, correção e exclusão dos seus dados, e pode revogar seu consentimento.

## 5. Contato

Dúvidas e pedidos: contato@rainhadocredito.com.$md$
);
insert into legal_documents (kind, version, title, body_md) values (
  'privacy', 1, 'Política de Privacidade',
  $md$> **Texto provisório.** Este texto será substituído pela versão aprovada antes da abertura do cadastro ao público.

## 1. Objeto

Esta política explica como a Rainha do Crédito trata os seus dados pessoais na plataforma.

## 2. Conta

Guardamos nome, documento, e-mail e telefone que você informa no cadastro. A senha fica protegida e nunca é lida por nossa equipe.

## 3. Dados tratados

Usamos esses dados para criar sua conta, confirmar seu contato, enviar avisos do serviço e atender pedidos de consulta. Não vendemos seus dados.

## 4. Direitos do titular

Pela LGPD, você pode pedir confirmação do tratamento, acesso, correção, anonimização, portabilidade e exclusão dos seus dados, e pode revogar seu consentimento.

## 5. Contato

Dúvidas e pedidos: contato@rainhadocredito.com.$md$
);

insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
values (
  'email_verification', 'email', 1, array['clientName', 'url'],
  $tpl$Confirme seu e-mail — Rainha do Crédito$tpl$,
  $tpl$<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#eef1f0;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f0;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:480px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <tr><td style="background:#0B5F59;text-align:center;padding:26px 24px 22px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.5px;">Eliane Moreira</div>
            <div style="font-size:11px;letter-spacing:3px;color:#C9A24B;margin-top:4px;">RAINHA DO CRÉDITO</div>
          </td></tr>
          <tr><td style="background:#0E8C84;color:#ffffff;text-align:center;padding:14px 24px;">
            <div style="font-size:17px;font-weight:700;">Confirme seu e-mail</div>
          </td></tr>
          <tr><td style="padding:26px 24px;text-align:center;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 22px;">Olá, {{clientName}}.</p>
            <a href="{{url}}" style="display:inline-block;background:#C9A24B;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px;padding:14px 28px;border-radius:6px;">Confirmar e-mail</a>
            <p style="margin:22px 0 0;font-size:12px;color:#6b7280;">Se o botão não funcionar, acesse: <br/><a href="{{url}}" style="color:#0B5F59;">{{url}}</a></p>
            <p style="margin:22px 0 0;font-size:12px;color:#6b7280;">O link vale por 24 horas.</p>
            <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">Se você não criou esta conta, ignore este e-mail.</p>
          </td></tr>
          <tr><td style="background:#0B5F59;padding:16px 24px;text-align:center;font-size:11px;color:#cfe7e4;">
            Eliane Moreira — Rainha do Crédito<br/>(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>$tpl$,
  $tpl$Olá, {{clientName}}.

Confirme seu e-mail em: {{url}}

O link vale por 24 horas.
Se você não criou esta conta, ignore este e-mail.

Eliane Moreira — Rainha do Crédito
(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito$tpl$
);
insert into notification_templates (key, channel, version, params, wa_template_name, wa_language)
values ('phone_verification', 'whatsapp', 1, array['code'], 'verification_code', 'pt_BR');
