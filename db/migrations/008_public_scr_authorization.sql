-- Anonymous SCR consent is limited to opaque-token reads and a single atomic
-- confirmation. `auth_profile_lookup` is the existing no-login BypassRLS role.

create function public.public_scr_authorization(
  p_token text,
  p_channel text
)
returns table (
  status text,
  type text,
  consent_text text,
  consent_name text,
  consent_document text,
  expires_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select
    s.status::text,
    s.type::text,
    coalesce(s.consent_text, ''),
    coalesce(s.consent_name, ''),
    coalesce(s.consent_document, s.document),
    s.expires_at
  from public.scr_authorizations s
  where s.public_token::text = p_token
    and s.channel = p_channel
    and p_channel = 'internal'
$$;

alter function public.public_scr_authorization(text, text) owner to auth_profile_lookup;
revoke all on function public.public_scr_authorization(text, text) from public;
grant execute on function public.public_scr_authorization(text, text) to app_runtime;

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
  v_authorization public.scr_authorizations%rowtype;
  v_authorized boolean;
begin
  select *
    into v_authorization
   from public.scr_authorizations s
   where s.public_token::text = p_token
     and s.channel = p_channel
     and p_channel = 'internal'
   for update;

  if not found then return 'not_found'; end if;
  if v_authorization.status::text in ('authorized', 'not_authorized') then
    return 'already';
  end if;
  if p_decision not in ('authorize', 'refuse') then return 'not_found'; end if;
  if p_decision = 'authorize'
     and (v_authorization.auth_code is null or upper(p_code) <> upper(v_authorization.auth_code)) then
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
   where id = v_authorization.id;

  if v_authorization.crm_client_id is not null then
    insert into public.timeline_events (entity_type, entity_id, event_type, title)
    values (
      'crm_client',
      v_authorization.crm_client_id,
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
