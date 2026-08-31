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

create or replace function app_context_present()
returns boolean
language sql
stable
as $$
  select app_user_id() is not null
    and app_user_role() in ('admin', 'consultant', 'client')
$$;

alter function app_user_id() owner to schema_owner;
alter function app_user_role() owner to schema_owner;
alter function app_context_present() owner to schema_owner;
revoke all on function app_user_id() from public;
revoke all on function app_user_role() from public;
revoke all on function app_context_present() from public;
grant execute on function app_user_id() to app_runtime;
grant execute on function app_user_role() to app_runtime;
grant execute on function app_context_present() to app_runtime;

create or replace function protect_profile_identity()
returns trigger
language plpgsql
as $$
begin
  if row(old.id, old.auth_user_id, old.created_at)
    is distinct from row(new.id, new.auth_user_id, new.created_at) then
    raise exception 'profile identity is immutable';
  end if;

  if row(old.role, old.is_active, old.mfa_enabled)
    is distinct from row(new.role, new.is_active, new.mfa_enabled)
    and app_user_role() is distinct from 'admin' then
    raise exception 'only administrators may change profile security fields';
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

alter table profiles enable row level security;
alter table profiles force row level security;
alter table credit_products enable row level security;
alter table credit_products force row level security;
alter table crm_clients enable row level security;
alter table crm_clients force row level security;
alter table crm_client_documents enable row level security;
alter table crm_client_documents force row level security;
alter table crm_client_relations enable row level security;
alter table crm_client_relations force row level security;
alter table batches enable row level security;
alter table batches force row level security;
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
alter table company_reports enable row level security;
alter table company_reports force row level security;
alter table opportunities enable row level security;
alter table opportunities force row level security;
alter table opportunity_documents enable row level security;
alter table opportunity_documents force row level security;
alter table timeline_events enable row level security;
alter table timeline_events force row level security;
alter table crm_notes enable row level security;
alter table crm_notes force row level security;
alter table settings enable row level security;
alter table settings force row level security;
alter table audit_logs enable row level security;
alter table audit_logs force row level security;

create policy profiles_select on profiles for select
  using (
    app_context_present()
    and app_user_role() in ('admin', 'consultant')
  );
create policy profiles_update on profiles for update
  using (
    app_context_present()
    and (app_user_role() = 'admin' or id = app_user_id())
  )
  with check (
    app_context_present()
    and (app_user_role() = 'admin' or id = app_user_id())
  );
create policy profiles_insert on profiles for insert
  with check (app_context_present() and app_user_role() = 'admin');

create policy credit_products_select on credit_products for select
  using (
    app_context_present()
    and app_user_role() in ('admin', 'consultant')
  );

create policy crm_clients_select on crm_clients for select
  using (
    app_context_present()
    and (app_user_role() in ('admin', 'consultant') or user_id = app_user_id())
  );
create policy crm_clients_write on crm_clients for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy crm_client_documents_staff on crm_client_documents for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy crm_client_relations_staff on crm_client_relations for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy batches_staff on batches for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy consultations_staff on consultations for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy scr_authorizations_staff on scr_authorizations for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy bureau_payloads_staff on bureau_payloads for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy bureau_results_staff on bureau_results for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy ai_reports_staff on ai_reports for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy company_reports_staff on company_reports for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy opportunities_staff on opportunities for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));
create policy opportunities_client_select on opportunities for select
  using (
    app_context_present()
    and app_user_role() = 'client'
    and exists (
      select 1
      from crm_clients
      where crm_clients.id = opportunities.crm_client_id
        and crm_clients.user_id = app_user_id()
    )
  );

create policy opportunity_documents_staff on opportunity_documents for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));
create policy opportunity_documents_client_select
  on opportunity_documents for select
  using (
    app_context_present()
    and app_user_role() = 'client'
    and exists (
      select 1
      from opportunities
      join crm_clients on crm_clients.id = opportunities.crm_client_id
      where opportunities.id = opportunity_documents.opportunity_id
        and crm_clients.user_id = app_user_id()
    )
  );

create policy timeline_events_staff_select on timeline_events for select
  using (app_context_present() and app_user_role() in ('admin', 'consultant'));
create policy timeline_events_staff_insert on timeline_events for insert
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));
create policy timeline_events_client_select on timeline_events for select
  using (
    app_context_present()
    and app_user_role() = 'client'
    and entity_type = 'opportunity'
    and exists (
      select 1
      from opportunities
      join crm_clients on crm_clients.id = opportunities.crm_client_id
      where opportunities.id = timeline_events.entity_id
        and crm_clients.user_id = app_user_id()
    )
  );

create policy crm_notes_staff on crm_notes for all
  using (app_context_present() and app_user_role() in ('admin', 'consultant'))
  with check (app_context_present() and app_user_role() in ('admin', 'consultant'));

create policy settings_select on settings for select
  using (app_context_present() and app_user_role() in ('admin', 'consultant'));
create policy settings_admin_write on settings for all
  using (app_context_present() and app_user_role() = 'admin')
  with check (app_context_present() and app_user_role() = 'admin');

create policy audit_logs_admin_select on audit_logs for select
  using (app_context_present() and app_user_role() = 'admin');
create policy audit_logs_staff_insert on audit_logs for insert
  with check (
    app_context_present()
    and app_user_role() in ('admin', 'consultant')
    and user_id = app_user_id()
  );

revoke all on all tables in schema public from public, app_runtime, backup_reader;

grant select, insert, update, delete
  on "user", "session", account, verification, two_factor
  to app_runtime;
grant select, insert, update on profiles to app_runtime;
grant select on credit_products to app_runtime;
grant select, insert, update on crm_clients to app_runtime;
grant select, insert on crm_client_documents, crm_client_relations to app_runtime;
grant select, insert, update on batches, consultations, scr_authorizations to app_runtime;
grant select on bureau_payloads to app_runtime;
grant insert (
  id, consultation_id, provider, product, received_at,
  http_status, payload, payload_sha256
) on bureau_payloads to app_runtime;
grant update (validation_status, validation_errors) on bureau_payloads to app_runtime;
grant select, insert on bureau_results to app_runtime;
grant select, insert, update on ai_reports, company_reports to app_runtime;
grant select, insert, update on opportunities to app_runtime;
grant select, insert, update, delete on opportunity_documents to app_runtime;
grant select, insert on timeline_events, crm_notes, audit_logs to app_runtime;
grant select, insert, update, delete on settings to app_runtime;

grant select on all tables in schema public to backup_reader;
alter default privileges for role schema_owner in schema public
  grant select on tables to backup_reader;
alter default privileges for role schema_owner in schema public
  revoke insert, update, delete, truncate, references, trigger on tables
  from backup_reader;
