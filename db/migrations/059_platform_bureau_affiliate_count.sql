-- Total de afiliados (affiliate_codes) por Bureau em platform_bureau_metrics.
-- A RLS de affiliate_codes bloqueia o superadmin fora de sessão de suporte; a função security definer
-- (dona auth_profile_lookup, com select em affiliate_codes desde a 026) devolve só a contagem.
-- O tipo de retorno muda: drop + create (022 + affiliate_count).
drop function public.platform_bureau_metrics();

create function public.platform_bureau_metrics()
returns table (
  bureau_id uuid, name text, slug text, status text,
  staff_count bigint, holder_count bigint, dossier_count bigint,
  consultation_count bigint, consultations_30d bigint, affiliate_count bigint
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
             where p.bureau_id = b.id and p.role in ('bureau_admin', 'operator') and not p.is_system),
           (select count(*) from public.holders h where h.bureau_id = b.id),
           (select count(*) from public.dossiers d where d.bureau_id = b.id),
           (select count(*) from public.consultations c where c.bureau_id = b.id),
           (select count(*) from public.consultations c
             where c.bureau_id = b.id and c.created_at > now() - interval '30 days'),
           (select count(*) from public.affiliate_codes a where a.bureau_id = b.id)
      from public.bureaus b
     order by b.name;
end
$$;

alter function public.platform_bureau_metrics() owner to auth_profile_lookup;
revoke all on function public.platform_bureau_metrics() from public;
grant execute on function public.platform_bureau_metrics() to app_runtime;
