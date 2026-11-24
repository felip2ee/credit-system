-- 1) record_bureau_page_view passa a contar o dia de Brasília (antes: current_date do banco, em UTC), a mesma base dos
--    períodos de getBureauAdminMetrics. Dono e grants da 056 continuam (create or replace).
create or replace function record_bureau_page_view(p_bureau_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.bureaus b where b.id = p_bureau_id and b.status = 'active') then
    return false;
  end if;
  insert into public.bureau_page_views (bureau_id, day, count)
  values (p_bureau_id, (now() at time zone 'America/Sao_Paulo')::date, 1)
  on conflict (bureau_id, day) do update set count = public.bureau_page_views.count + 1;
  return true;
end
$$;

-- 2) -- A página pública só conhece o slug (public_bureau_by_slug não devolve o id): conta a visita por slug.
-- Slug desconhecido ou de bureau inativo não grava nada. Devolve se gravou.
create function record_bureau_page_view_by_slug(p_slug text)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select public.record_bureau_page_view(b.id) from public.bureaus b where b.slug = p_slug),
    false
  )
$$;

alter function record_bureau_page_view_by_slug(text) owner to auth_profile_lookup;
revoke all on function record_bureau_page_view_by_slug(text) from public;
grant execute on function record_bureau_page_view_by_slug(text) to app_runtime;
