create or replace function app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app_user_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.user_role', true), '')
$$;

create or replace function app_bureau_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.bureau_id', true), '')::uuid
$$;

create or replace function app_support_session_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.support_session_id', true), '')::uuid
$$;

create or replace function app_context_present()
returns boolean
language sql
stable
as $$
  select app_user_id() is not null
    and app_user_role() in ('superadmin', 'bureau_admin', 'operator', 'client')
$$;

-- Dono auth_profile_lookup. Lê support_sessions sem expor a tabela ao app.
create function app_support_active()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.support_sessions s
     where s.id = public.app_support_session_id()
       and s.superadmin_id = public.app_user_id()
       and s.bureau_id = public.app_bureau_id()
       and s.ended_at is null
       and s.started_at <= now()
       and s.expires_at > now())
$$;

create function app_is_staff()
returns boolean
language sql
stable
as $$
  select app_context_present() and (
    app_user_role() in ('bureau_admin', 'operator')
    or (app_user_role() = 'superadmin' and app_support_active()))
$$;

alter function app_user_id() owner to schema_owner;
alter function app_user_role() owner to schema_owner;
alter function app_bureau_id() owner to schema_owner;
alter function app_support_session_id() owner to schema_owner;
alter function app_context_present() owner to schema_owner;
alter function app_support_active() owner to auth_profile_lookup;
alter function app_is_staff() owner to schema_owner;
revoke all on function app_user_id() from public;
revoke all on function app_user_role() from public;
revoke all on function app_bureau_id() from public;
revoke all on function app_support_session_id() from public;
revoke all on function app_context_present() from public;
revoke all on function app_support_active() from public;
revoke all on function app_is_staff() from public;
grant execute on function app_user_id() to app_runtime;
grant execute on function app_user_role() to app_runtime;
grant execute on function app_bureau_id() to app_runtime;
grant execute on function app_support_session_id() to app_runtime;
grant execute on function app_context_present() to app_runtime;
grant execute on function app_support_active() to app_runtime;
grant execute on function app_is_staff() to app_runtime;

create function auth_profile_for_session(auth_id text)
returns table (
  user_id uuid,
  role text,
  bureau_id uuid,
  bureau_active boolean,
  is_active boolean,
  mfa_enabled boolean,
  support_session_id uuid,
  support_bureau_id uuid,
  support_expires_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id, p.role::text, p.bureau_id, coalesce(b.status = 'active', false),
         p.is_active, p.mfa_enabled, s.id, s.bureau_id, s.expires_at
    from public.profiles p
    left join public.bureaus b on b.id = p.bureau_id
    left join lateral (
      select ss.id, ss.bureau_id, ss.expires_at
        from public.support_sessions ss
       where p.role = 'superadmin' and ss.superadmin_id = p.id
         and ss.ended_at is null and ss.started_at <= now() and ss.expires_at > now()
       order by ss.started_at desc
       limit 1) s on true
   where p.auth_user_id = auth_id
$$;

alter function auth_profile_for_session(text) owner to auth_profile_lookup;
revoke all on function auth_profile_for_session(text) from public;
grant execute on function auth_profile_for_session(text) to app_runtime;

create or replace function protect_profile_identity()
returns trigger
language plpgsql
as $$
begin
  if row(old.id, old.auth_user_id, old.created_at, old.bureau_id)
    is distinct from row(new.id, new.auth_user_id, new.created_at, new.bureau_id) then
    raise exception 'profile identity is immutable';
  end if;

  if row(old.role, old.is_active, old.mfa_enabled)
    is distinct from row(new.role, new.is_active, new.mfa_enabled)
    and app_user_role() is distinct from 'bureau_admin' then
    raise exception 'only administrators may change profile security fields';
  end if;

  if old.role is distinct from new.role
    and not (old.role in ('bureau_admin', 'operator') and new.role in ('bureau_admin', 'operator')) then
    raise exception 'role may only change between bureau_admin and operator';
  end if;

  return new;
end
$$;

alter function protect_profile_identity() owner to schema_owner;
revoke all on function protect_profile_identity() from public;
grant execute on function protect_profile_identity() to app_runtime;

create trigger protect_profile_identity
  before update on profiles
  for each row execute function protect_profile_identity();

alter table bureaus enable row level security;
alter table bureaus force row level security;
alter table profiles enable row level security;
alter table profiles force row level security;
alter table holders enable row level security;
alter table holders force row level security;
alter table holder_partnerships enable row level security;
alter table holder_partnerships force row level security;
alter table dossiers enable row level security;
alter table dossiers force row level security;
alter table consultations enable row level security;
alter table consultations force row level security;
alter table scr_authorizations enable row level security;
alter table scr_authorizations force row level security;
alter table bureau_payloads enable row level security;
alter table bureau_payloads force row level security;
alter table bureau_results enable row level security;
alter table bureau_results force row level security;
alter table ai_reports enable row level security;
alter table ai_reports force row level security;
alter table timeline_events enable row level security;
alter table timeline_events force row level security;
alter table crm_notes enable row level security;
alter table crm_notes force row level security;
alter table settings enable row level security;
alter table settings force row level security;
alter table support_sessions enable row level security;
alter table support_sessions force row level security;
alter table audit_logs enable row level security;
alter table audit_logs force row level security;

create policy bureaus_select on bureaus for select
  using (
    app_context_present()
    and (app_user_role() = 'superadmin' or id = app_bureau_id())
  );
create policy bureaus_insert on bureaus for insert
  with check (app_context_present() and app_user_role() = 'superadmin');
create policy bureaus_update on bureaus for update
  using (app_context_present() and app_user_role() = 'superadmin')
  with check (app_context_present() and app_user_role() = 'superadmin');

create policy profiles_select on profiles for select
  using (
    app_context_present()
    and (
      id = app_user_id()
      or (bureau_id = app_bureau_id() and (select app_is_staff()))
      or (app_user_role() = 'superadmin' and role in ('superadmin', 'bureau_admin'))
    )
  );
create policy profiles_update on profiles for update
  using (
    app_context_present()
    and (
      id = app_user_id()
      or (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
    )
  )
  with check (
    app_context_present()
    and (
      id = app_user_id()
      or (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
    )
  );
create policy profiles_insert on profiles for insert
  with check (
    app_context_present()
    and (
      (
        app_user_role() = 'bureau_admin'
        and bureau_id = app_bureau_id()
        and role in ('bureau_admin', 'operator', 'client')
      )
      or (
        app_user_role() = 'superadmin'
        and (
          (role = 'bureau_admin' and bureau_id is not null)
          or (role = 'superadmin' and id = app_user_id())
        )
      )
    )
  );

create policy holders_staff on holders for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy holders_client_select on holders for select
  using (
    app_context_present() and app_user_role() = 'client'
    and bureau_id = app_bureau_id() and client_profile_id = app_user_id()
  );

create policy holder_partnerships_staff on holder_partnerships for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy dossiers_staff on dossiers for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy consultations_staff on consultations for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy scr_authorizations_staff on scr_authorizations for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy bureau_payloads_staff on bureau_payloads for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy bureau_results_staff on bureau_results for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy ai_reports_staff on ai_reports for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy timeline_events_staff_select on timeline_events for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy timeline_events_staff_insert on timeline_events for insert
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy crm_notes_staff on crm_notes for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));

-- ended_at é write-once: encerrar uma vez, nunca reabrir, nunca alterar outra coluna.
create function support_sessions_guard_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.ended_at is not null
     or new.ended_at is null
     or new.ended_at < old.started_at
     or (to_jsonb(new) - 'ended_at') is distinct from (to_jsonb(old) - 'ended_at') then
    raise exception 'support_sessions: only a single ended_at write is allowed'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger support_sessions_guard_update before update on support_sessions
  for each row execute function support_sessions_guard_update();

-- No máximo 1 sessão aberta por superadmin no caminho do app. Seeds e o dono
-- (migrações, testes) podem manter várias; por isso não é índice único.
create function support_sessions_guard_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user = 'app_runtime' then
    perform pg_advisory_xact_lock(hashtextextended(new.superadmin_id::text, 0));
    if exists (
      select 1 from public.support_sessions s
       where s.superadmin_id = new.superadmin_id
         and s.ended_at is null and s.expires_at > now()) then
      raise exception 'support_sessions: superadmin already has an open session'
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger support_sessions_guard_insert before insert on support_sessions
  for each row execute function support_sessions_guard_insert();

create policy support_sessions_superadmin on support_sessions for all
  using (
    app_context_present() and app_user_role() = 'superadmin'
    and superadmin_id = app_user_id()
  )
  with check (
    app_context_present() and app_user_role() = 'superadmin'
    and superadmin_id = app_user_id()
  );

create policy settings_select on settings for select
  using (app_context_present());
create policy settings_superadmin_write on settings for all
  using (app_context_present() and app_user_role() = 'superadmin')
  with check (app_context_present() and app_user_role() = 'superadmin');

create policy audit_logs_select on audit_logs for select
  using (
    app_context_present()
    and (
      (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
      or (app_user_role() = 'superadmin' and (bureau_id is null or support_session_id is not null))
    )
  );
create policy audit_logs_insert on audit_logs for insert with check (
  app_context_present()
  and user_id = app_user_id()
  and bureau_id is not distinct from app_bureau_id()
  and support_session_id is not distinct from app_support_session_id()
  and (bureau_id is null) = (app_user_role() = 'superadmin' and app_support_session_id() is null));

revoke all on all tables in schema public from public, app_runtime, backup_reader;

grant select, insert, update, delete
  on "user", "session", account, verification, rate_limit, two_factor
  to app_runtime;
grant select, insert, update on profiles to app_runtime;
grant select, insert, update (name, status) on bureaus to app_runtime;
grant select, insert, update on holders, holder_partnerships, dossiers to app_runtime;
grant select, insert, update on consultations, scr_authorizations to app_runtime;
grant select on bureau_payloads to app_runtime;
grant insert (
  id, bureau_id, consultation_id, provider, product, received_at,
  http_status, payload, payload_sha256
) on bureau_payloads to app_runtime;
grant update (validation_status, validation_errors) on bureau_payloads to app_runtime;
grant select, insert on bureau_results to app_runtime;
grant select, insert, update on ai_reports to app_runtime;
grant select, insert on timeline_events, crm_notes, audit_logs to app_runtime;
-- started_at/expires_at vêm só dos defaults (1 hora); o app não escolhe.
grant select, insert (superadmin_id, bureau_id, reason), update (ended_at)
  on support_sessions to app_runtime;
grant select, insert, update, delete on settings to app_runtime;

grant select on all tables in schema public to backup_reader;
alter default privileges for role schema_owner in schema public
  grant select on tables to backup_reader;
alter default privileges for role schema_owner in schema public
  revoke insert, update, delete, truncate, references, trigger on tables
  from backup_reader;
