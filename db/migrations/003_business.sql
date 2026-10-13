create extension if not exists pgcrypto;

create type user_role as enum ('admin', 'consultant', 'client');
create type query_type as enum ('PF', 'PJ');
create type consultation_status as enum (
  'pending_authorization',
  'authorized',
  'processing',
  'completed',
  'payload_incompatible',
  'error',
  'rejected'
);
create type batch_status as enum (
  'pending', 'processing', 'completed', 'completed_with_errors', 'cancelled'
);
create type scr_status as enum (
  'pending', 'authorized', 'not_authorized', 'expired'
);
create type timeline_entity_type as enum ('crm_client', 'query');

create table profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null unique references "user"(id) on delete restrict,
  full_name text not null,
  email text not null,
  role user_role not null default 'consultant',
  avatar_url text,
  is_active boolean not null default true,
  mfa_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_auth_id_matches_id check (auth_user_id = id::text)
);

create table crm_clients (
  id uuid primary key default gen_random_uuid(),
  type query_type not null,
  name text not null,
  document text,
  email text,
  phone text,
  address text,
  address_number text,
  address_complement text,
  neighborhood text,
  city text,
  state char(2),
  zip_code text,
  status text not null default 'prospect',
  assigned_to uuid references profiles(id) on delete set null,
  user_id uuid references profiles(id) on delete set null,
  notes text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm_client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references crm_clients(id) on delete cascade,
  type query_type not null,
  document text not null,
  label text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (client_id, document)
);

create table crm_client_relations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references crm_clients(id) on delete cascade,
  related_id uuid not null references crm_clients(id) on delete cascade,
  relation_type text not null,
  percentage numeric(5,2),
  role text,
  created_at timestamptz not null default now(),
  unique (client_id, related_id, relation_type)
);

create table batches (
  id uuid primary key default gen_random_uuid(),
  name text,
  type query_type not null,
  product text,
  document text,
  created_by uuid not null references profiles(id),
  status batch_status not null default 'pending',
  total_items integer not null default 0,
  processed_items integer not null default 0,
  success_items integer not null default 0,
  error_items integer not null default 0,
  file_name text,
  file_path text,
  report_path text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table consultations (
  id uuid primary key default gen_random_uuid(),
  type query_type not null,
  document text not null,
  document_name text,
  product text,
  crm_client_id uuid references crm_clients(id) on delete set null,
  batch_id uuid references batches(id) on delete set null,
  created_by uuid not null references profiles(id),
  status consultation_status not null default 'pending_authorization',
  requires_auth boolean not null default false,
  observations text,
  historico_consulta_id text,
  consulted_at timestamptz,
  api_version integer,
  product_version text,
  is_partial boolean,
  share_link text,
  error_message text,
  scr_email text,
  scr_mode text not null default 'internal'
    check (scr_mode in ('internal', 'deps')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table scr_authorizations (
  id uuid primary key default gen_random_uuid(),
  document text not null,
  type query_type not null,
  name text,
  email text,
  consultation_id uuid references consultations(id) on delete set null,
  crm_client_id uuid references crm_clients(id) on delete set null,
  status scr_status not null default 'pending',
  requested_by uuid references profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  authorized_at timestamptz,
  expires_at timestamptz,
  last_checked_at timestamptz,
  channel text not null default 'deps' check (channel in ('deps', 'internal')),
  auth_code text,
  public_token uuid default gen_random_uuid() unique,
  consent_text text,
  consent_name text,
  consent_document text,
  consented_at timestamptz,
  consent_ip text,
  refused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bureau_payloads (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  provider text not null check (provider = 'deps'),
  product text not null,
  received_at timestamptz not null,
  http_status integer not null check (http_status between 100 and 599),
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'valid', 'incompatible')),
  validation_errors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_errors) = 'array'),
  unique (consultation_id, payload_sha256)
);

create table bureau_results (
  consultation_id uuid primary key references consultations(id) on delete cascade,
  payload_id uuid not null unique references bureau_payloads(id),
  adapter_version integer not null check (adapter_version > 0),
  canonical_result jsonb not null,
  document text not null,
  person_name text,
  score integer,
  risk_level text,
  created_at timestamptz not null default now()
);

create table ai_reports (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null unique references consultations(id) on delete cascade,
  crm_client_id uuid references crm_clients(id) on delete set null,
  aptitude_status text not null default 'pending',
  executive_summary text,
  positive_points jsonb,
  risk_points jsonb,
  action_plan jsonb,
  suggested_products jsonb,
  suggested_limit numeric(15,2),
  suggested_limit_notes text,
  report_markdown text,
  full_report jsonb,
  model_used text,
  prompt_version text,
  generated_at timestamptz,
  generation_error text,
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  consultant_notes text,
  status text not null default 'generating',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table company_reports (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references batches(id) on delete cascade,
  aptitude_status text not null default 'pending',
  executive_summary text,
  positive_points jsonb,
  risk_points jsonb,
  action_plan jsonb,
  suggested_products jsonb,
  suggested_limit numeric(15,2),
  suggested_limit_notes text,
  report_markdown text,
  full_report jsonb,
  model_used text,
  prompt_version text,
  generated_at timestamptz,
  generation_error text,
  status text not null default 'generating',
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table timeline_events (
  id uuid primary key default gen_random_uuid(),
  entity_type timeline_entity_type not null,
  entity_id uuid not null,
  event_type text not null,
  title text not null,
  description text,
  metadata jsonb,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table crm_notes (
  id uuid primary key default gen_random_uuid(),
  entity_type timeline_entity_type not null,
  entity_id uuid not null,
  content text not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  action text not null,
  table_name text,
  record_id uuid,
  outcome text not null default 'success',
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();
create trigger crm_clients_updated_at before update on crm_clients
  for each row execute function set_updated_at();
create trigger batches_updated_at before update on batches
  for each row execute function set_updated_at();
create trigger consultations_updated_at before update on consultations
  for each row execute function set_updated_at();
create trigger scr_authorizations_updated_at before update on scr_authorizations
  for each row execute function set_updated_at();
create trigger ai_reports_updated_at before update on ai_reports
  for each row execute function set_updated_at();
create trigger company_reports_updated_at before update on company_reports
  for each row execute function set_updated_at();
create trigger crm_notes_updated_at before update on crm_notes
  for each row execute function set_updated_at();

create or replace function enforce_bureau_payload_transition()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.consultation_id,
    old.provider,
    old.product,
    old.received_at,
    old.http_status,
    old.payload,
    old.payload_sha256
  ) is distinct from row(
    new.consultation_id,
    new.provider,
    new.product,
    new.received_at,
    new.http_status,
    new.payload,
    new.payload_sha256
  ) then
    raise exception 'bureau payload evidence is immutable';
  end if;

  if old.validation_status <> 'pending'
    or new.validation_status not in ('valid', 'incompatible') then
    raise exception 'invalid bureau payload validation transition';
  end if;

  return new;
end
$$;

create trigger bureau_payload_transition
  before update on bureau_payloads
  for each row execute function enforce_bureau_payload_transition();

alter type user_role owner to schema_owner;
alter type query_type owner to schema_owner;
alter type consultation_status owner to schema_owner;
alter type batch_status owner to schema_owner;
alter type scr_status owner to schema_owner;
alter type timeline_entity_type owner to schema_owner;
alter function set_updated_at() owner to schema_owner;
alter function enforce_bureau_payload_transition() owner to schema_owner;

alter table profiles owner to schema_owner;
alter table crm_clients owner to schema_owner;
alter table crm_client_documents owner to schema_owner;
alter table crm_client_relations owner to schema_owner;
alter table batches owner to schema_owner;
alter table consultations owner to schema_owner;
alter table scr_authorizations owner to schema_owner;
alter table bureau_payloads owner to schema_owner;
alter table bureau_results owner to schema_owner;
alter table ai_reports owner to schema_owner;
alter table company_reports owner to schema_owner;
alter table timeline_events owner to schema_owner;
alter table crm_notes owner to schema_owner;
alter table settings owner to schema_owner;
alter table audit_logs owner to schema_owner;
