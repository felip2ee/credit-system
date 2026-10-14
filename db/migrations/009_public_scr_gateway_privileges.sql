-- The gateway function owner must obey RLS. Only the read-only backup role may
-- bypass it; these grants and policies are the complete boundary of the public
-- SCR gateway and of the cross-tenant SECURITY DEFINER functions
-- (auth_profile_for_session, app_support_active, public_bureau_by_slug,
-- platform_bureau_metrics, admin_set_credentials).

alter role auth_profile_lookup NOLOGIN NOINHERIT NOBYPASSRLS;

-- Tenant policies apply to every role, so the gateway owner must be able to
-- evaluate their helper functions (they return false without a user context).
grant execute on function
  public.app_user_id(), public.app_user_role(), public.app_bureau_id(),
  public.app_support_session_id(), public.app_context_present(),
  public.app_support_active(), public.app_is_staff()
  to auth_profile_lookup;

revoke all on public.profiles from auth_profile_lookup;
revoke all on public.bureaus from auth_profile_lookup;
revoke all on public.support_sessions from auth_profile_lookup;
revoke all on public.scr_authorizations from auth_profile_lookup;
revoke all on public.timeline_events from auth_profile_lookup;
revoke all on public.holders from auth_profile_lookup;
revoke all on public.dossiers from auth_profile_lookup;
revoke all on public.consultations from auth_profile_lookup;

grant select (id, auth_user_id, role, is_active, mfa_enabled, bureau_id, must_change_password)
  on public.profiles to auth_profile_lookup;
grant update (must_change_password) on public.profiles to auth_profile_lookup;
grant select (user_id, provider_id), update (password, updated_at),
  insert (id, issuer, account_id, provider_id, user_id, password, updated_at)
  on public.account to auth_profile_lookup;
grant select (user_id), delete on public."session" to auth_profile_lookup;
-- admin_set_credentials apaga os tokens de redefinição de senha pendentes do alvo.
grant select (identifier, value), delete on public.verification to auth_profile_lookup;
grant select (id, name, slug, status) on public.bureaus to auth_profile_lookup;
grant select (id, superadmin_id, bureau_id, started_at, expires_at, ended_at)
  on public.support_sessions to auth_profile_lookup;
grant select (
  id, status, auth_code, bureau_id, holder_id, public_token, channel, type,
  consent_text, consent_name, consent_document, document, expires_at
) on public.scr_authorizations to auth_profile_lookup;
grant update (
  status, authorized_at, consented_at, consent_ip, refused_at, expires_at,
  last_checked_at, auth_code
) on public.scr_authorizations to auth_profile_lookup;
grant insert (bureau_id, entity_type, entity_id, event_type, title)
  on public.timeline_events to auth_profile_lookup;
-- Only ids and counters for platform_bureau_metrics.
grant select (id, bureau_id) on public.holders to auth_profile_lookup;
grant select (id, bureau_id) on public.dossiers to auth_profile_lookup;
grant select (id, bureau_id, created_at) on public.consultations to auth_profile_lookup;

create policy profiles_gateway_lookup on public.profiles for select to auth_profile_lookup
  using (true);
create policy profiles_gateway_update on public.profiles for update to auth_profile_lookup
  using (role in ('bureau_admin', 'operator'))
  with check (role in ('bureau_admin', 'operator'));
create policy bureaus_gateway_select on public.bureaus for select to auth_profile_lookup
  using (true);
create policy support_sessions_gateway_select on public.support_sessions for select to auth_profile_lookup
  using (true);
create policy holders_gateway_select on public.holders for select to auth_profile_lookup
  using (true);
create policy dossiers_gateway_select on public.dossiers for select to auth_profile_lookup
  using (true);
create policy consultations_gateway_select on public.consultations for select to auth_profile_lookup
  using (true);
create policy scr_authorizations_gateway_select on public.scr_authorizations for select to auth_profile_lookup
  using (channel = 'internal');
create policy scr_authorizations_gateway_update on public.scr_authorizations for update to auth_profile_lookup
  using (channel = 'internal')
  with check (channel = 'internal');
create policy timeline_events_gateway_insert on public.timeline_events for insert to auth_profile_lookup
  with check (
    entity_type = 'holder'
    and (
      (event_type = 'scr.self_authorized' and title = 'Autorização SCR concedida pelo titular')
      or (event_type = 'scr.self_refused' and title = 'Autorização SCR recusada pelo titular')
    )
    and exists (
      select 1 from public.scr_authorizations s
       where s.holder_id = timeline_events.entity_id
         and s.bureau_id = timeline_events.bureau_id
         and s.channel = 'internal')
  );

create function public.confirm_public_scr_authorization(
  p_token text,
  p_channel text,
  p_code text,
  p_decision text,
  p_ip text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_status text;
  v_auth_code text;
  v_bureau_id uuid;
  v_holder_id uuid;
  v_authorized boolean;
begin
  select s.id, s.status::text, s.auth_code, s.bureau_id, s.holder_id
    into v_id, v_status, v_auth_code, v_bureau_id, v_holder_id
    from public.scr_authorizations s
   where s.public_token = case when p_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_token::uuid end
     and s.channel = p_channel
     and p_channel = 'internal'
   for update;

  if not found then return 'not_found'; end if;
  if v_status in ('authorized', 'not_authorized') then return 'already'; end if;
  if p_decision not in ('authorize', 'refuse') then return 'not_found'; end if;
  if p_decision = 'authorize'
     and (v_auth_code is null or upper(p_code) <> upper(v_auth_code)) then
    return 'invalid_code';
  end if;

  v_authorized := p_decision = 'authorize';
  update public.scr_authorizations
     set status = case when v_authorized then 'authorized'::public.scr_status else 'not_authorized'::public.scr_status end,
         authorized_at = case when v_authorized then now() else null end,
         consented_at = case when v_authorized then now() else null end,
         consent_ip = case when v_authorized then p_ip else null end,
         refused_at = case when v_authorized then null else now() end,
         expires_at = case when v_authorized then now() + interval '365 days' else null end,
         last_checked_at = now(),
         auth_code = null
   where id = v_id;

  insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title)
  values (
    v_bureau_id,
    'holder',
    v_holder_id,
    case when v_authorized then 'scr.self_authorized' else 'scr.self_refused' end,
    case when v_authorized then 'Autorização SCR concedida pelo titular' else 'Autorização SCR recusada pelo titular' end
  );

  return case when v_authorized then 'authorized' else 'refused' end;
end
$$;

alter function public.confirm_public_scr_authorization(text, text, text, text, text) owner to auth_profile_lookup;
revoke all on function public.confirm_public_scr_authorization(text, text, text, text, text) from public;
grant execute on function public.confirm_public_scr_authorization(text, text, text, text, text) to app_runtime;

create function public.public_bureau_by_slug(p_slug text)
returns table (name text, slug text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.name, b.slug from public.bureaus b
   where b.slug = p_slug and b.status = 'active'
$$;

alter function public.public_bureau_by_slug(text) owner to auth_profile_lookup;
revoke all on function public.public_bureau_by_slug(text) from public;
grant execute on function public.public_bureau_by_slug(text) to app_runtime;

create function public.platform_bureau_metrics()
returns table (
  bureau_id uuid, name text, slug text, status text,
  staff_count bigint, holder_count bigint, dossier_count bigint,
  consultation_count bigint, consultations_30d bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.app_user_id() is null or public.app_user_role() is distinct from 'superadmin' then
    raise exception 'superadmin context required' using errcode = '42501';
  end if;
  return query
    select b.id, b.name, b.slug, b.status,
           (select count(*) from public.profiles p
             where p.bureau_id = b.id and p.role in ('bureau_admin', 'operator')),
           (select count(*) from public.holders h where h.bureau_id = b.id),
           (select count(*) from public.dossiers d where d.bureau_id = b.id),
           (select count(*) from public.consultations c where c.bureau_id = b.id),
           (select count(*) from public.consultations c
             where c.bureau_id = b.id and c.created_at > now() - interval '30 days')
      from public.bureaus b
     order by b.name;
end
$$;

alter function public.platform_bureau_metrics() owner to auth_profile_lookup;
revoke all on function public.platform_bureau_metrics() from public;
grant execute on function public.platform_bureau_metrics() to app_runtime;

-- Define a senha temporária (hash) e/ou liga must_change_password; apaga as sessões e os tokens de redefinição do alvo.
-- Quem chama: superadmin em contexto de plataforma, ou bureau_admin ativo no próprio Bureau.
-- Alvo: superadmin → bureau_admin de p_bureau_id; bureau_admin → operator do próprio Bureau.
-- false = alvo inexistente, de outro papel/Bureau, ou convite pendente sem hash (sem enumerar).
create function public.admin_set_credentials(
  p_target_id uuid,
  p_bureau_id uuid,
  p_password_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := public.app_user_role();
begin
  if public.app_user_id() is null
     or not exists (
       select 1 from public.profiles c
        where c.id = public.app_user_id() and c.role::text = v_role and c.is_active)
     or not (
       (v_role = 'superadmin' and public.app_bureau_id() is null)
       or (v_role = 'bureau_admin' and p_bureau_id = public.app_bureau_id())) then
    raise exception 'admin context required' using errcode = '42501';
  end if;

  perform 1 from public.profiles p
   where p.id = p_target_id
     and p.bureau_id = p_bureau_id
     and p.role::text = case v_role when 'superadmin' then 'bureau_admin' else 'operator' end
   for update;
  if not found then
    return false;
  end if;

  if p_password_hash is not null then
    update public.account set password = p_password_hash, updated_at = now()
     where user_id = p_target_id::text and provider_id = 'credential';
    if not found then
      insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
      values (gen_random_uuid()::text, 'local:credential', p_target_id::text, 'credential',
              p_target_id::text, p_password_hash, now());
    end if;
  elsif not exists (
    select 1 from public.account a
     where a.user_id = p_target_id::text and a.provider_id = 'credential') then
    return false;
  end if;

  update public.profiles set must_change_password = true where id = p_target_id;
  delete from public."session" where user_id = p_target_id::text;
  -- Better Auth guarda o link de redefinição como identifier 'reset-password:<token>', value = id do usuário.
  delete from public.verification
   where value = p_target_id::text and identifier like 'reset-password:%';
  return true;
end
$$;

alter function public.admin_set_credentials(uuid, uuid, text) owner to auth_profile_lookup;
revoke all on function public.admin_set_credentials(uuid, uuid, text) from public;
grant execute on function public.admin_set_credentials(uuid, uuid, text) to app_runtime;
