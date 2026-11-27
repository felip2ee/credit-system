-- Interruptor do afiliado de link (plano afiliado-bureaus, parte 2, task 3).
-- 068 já ignora o afiliado de link quando affiliate_enabled é falso (join com bureau_affiliate_settings): sem mudança lá.
-- 1) O bureau_admin liga e desliga o recurso do próprio Bureau. O superadmin fora de suporte já escrevia (055).
--    A % de afiliados (default_pct) continua só do superadmin: o insert do bureau_admin exige default_pct = 0 e o gatilho
--    barra qualquer mudança de default_pct feita por ele.
-- 2) O cliente não lê bureau_affiliate_settings (RLS). affiliate_enabled() devolve só o booleano do Bureau da sessão,
--    para as páginas e ações do portal decidirem se a seção de afiliado está aberta. Sem linha = desligado.
create policy bureau_affiliate_settings_admin_insert on bureau_affiliate_settings for insert with check (
  app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id()
  and default_pct = 0 and updated_by = app_user_id()
);
create policy bureau_affiliate_settings_admin_update on bureau_affiliate_settings for update
  using (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
  with check (
    app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id()
    and updated_by = app_user_id());

create function bureau_affiliate_settings_admin_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if public.app_user_role() = 'bureau_admin' and new.default_pct is distinct from old.default_pct then
    raise exception 'default_pct_superadmin_only' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger bureau_affiliate_settings_admin_guard before update on bureau_affiliate_settings
  for each row execute function bureau_affiliate_settings_admin_guard();

create function affiliate_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(bool_or(s.affiliate_enabled), false)
    from public.bureau_affiliate_settings s
   where s.bureau_id = public.app_bureau_id() and public.app_context_present()
$$;
alter function affiliate_enabled() owner to auth_profile_lookup;
revoke all on function affiliate_enabled() from public;
grant execute on function affiliate_enabled() to app_runtime;
