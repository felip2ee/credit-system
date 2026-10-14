-- Anonymous SCR consent is limited to opaque-token reads (here) and a single atomic
-- confirmation (009). `auth_profile_lookup` is the existing no-login gateway role.

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
  -- Compare as uuid so the unique index on public_token is usable; a malformed token
  -- yields null (no match) instead of an invalid-cast error.
  where s.public_token = case when p_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_token::uuid end
    and s.channel = p_channel
    and p_channel = 'internal'
$$;

alter function public.public_scr_authorization(text, text) owner to auth_profile_lookup;
revoke all on function public.public_scr_authorization(text, text) from public;
grant execute on function public.public_scr_authorization(text, text) to app_runtime;
