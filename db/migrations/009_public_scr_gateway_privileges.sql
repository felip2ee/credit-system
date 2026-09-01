-- The gateway function owner must obey RLS. Only the read-only backup role may
-- bypass it; these grants and policies are the complete public SCR boundary.

alter role auth_profile_lookup NOLOGIN NOINHERIT NOBYPASSRLS;

revoke all on public.profiles from auth_profile_lookup;
revoke all on public.scr_authorizations from auth_profile_lookup;
revoke all on public.timeline_events from auth_profile_lookup;

grant select (id, auth_user_id, role, is_active, mfa_enabled)
  on public.profiles to auth_profile_lookup;
grant select (
  id, status, auth_code, crm_client_id, public_token, channel, type,
  consent_text, consent_name, consent_document, document, expires_at
) on public.scr_authorizations to auth_profile_lookup;
grant update (
  status, authorized_at, consented_at, consent_ip, refused_at, expires_at,
  last_checked_at, auth_code
) on public.scr_authorizations to auth_profile_lookup;
grant insert (entity_type, entity_id, event_type, title)
  on public.timeline_events to auth_profile_lookup;

create policy profiles_gateway_lookup on public.profiles for select to auth_profile_lookup
  using (true);
create policy scr_authorizations_gateway_select on public.scr_authorizations for select to auth_profile_lookup
  using (channel = 'internal');
create policy scr_authorizations_gateway_update on public.scr_authorizations for update to auth_profile_lookup
  using (channel = 'internal')
  with check (channel = 'internal');
create policy timeline_events_gateway_insert on public.timeline_events for insert to auth_profile_lookup
  with check (
    entity_type = 'crm_client'
    and (
      (event_type = 'scr.self_authorized' and title = 'Autorização SCR concedida pelo titular')
      or (event_type = 'scr.self_refused' and title = 'Autorização SCR recusada pelo titular')
    )
  );

create or replace function public.confirm_public_scr_authorization(
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
  v_crm_client_id uuid;
  v_authorized boolean;
begin
  select s.id, s.status::text, s.auth_code, s.crm_client_id
    into v_id, v_status, v_auth_code, v_crm_client_id
    from public.scr_authorizations s
   where s.public_token::text = p_token
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

  if v_crm_client_id is not null then
    insert into public.timeline_events (entity_type, entity_id, event_type, title)
    values (
      'crm_client',
      v_crm_client_id,
      case when v_authorized then 'scr.self_authorized' else 'scr.self_refused' end,
      case when v_authorized then 'Autorização SCR concedida pelo titular' else 'Autorização SCR recusada pelo titular' end
    );
  end if;

  return case when v_authorized then 'authorized' else 'refused' end;
end
$$;

alter function public.confirm_public_scr_authorization(text, text, text, text, text) owner to auth_profile_lookup;
revoke all on function public.confirm_public_scr_authorization(text, text, text, text, text) from public;
grant execute on function public.confirm_public_scr_authorization(text, text, text, text, text) to app_runtime;
