create extension if not exists pgcrypto;

create type user_role as enum ('superadmin', 'bureau_admin', 'operator', 'client');
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
create type dossier_kind as enum ('PF', 'PJ', 'PJ_FULL');
create type dossier_status as enum (
  'pending', 'processing', 'completed', 'completed_with_errors', 'cancelled'
);
create type scr_status as enum (
  'pending', 'authorized', 'not_authorized', 'expired'
);
create type timeline_entity_type as enum ('holder', 'query');

create table bureaus (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  slug text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bureaus_slug_format check (slug ~ '^[a-z0-9-]{3,40}$'),
  constraint bureaus_slug_not_reserved check (slug not in (
    'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'login', 'logout', 'mfa',
    'portal', 'autorizacao-scr', 'superadmin', 'settings', 'reset-password',
    'update-password', 'static', 'www'))
);

create table profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null unique references "user"(id) on delete restrict,
  full_name text not null,
  email text not null,
  role user_role not null,
  bureau_id uuid references bureaus(id),
  avatar_url text,
  is_active boolean not null default true,
  mfa_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_auth_id_matches_id check (auth_user_id = id::text),
  constraint profiles_bureau_matches_role check ((role = 'superadmin') = (bureau_id is null)),
  unique (bureau_id, id)
);

-- Titular. Toda FK entre tabelas de tenant é composta (bureau_id, id): uma
-- linha de um Bureau nunca aponta para linha de outro.
create table holders (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  type query_type not null,
  name text not null,
  document text not null,
  document_digits text generated always as (regexp_replace(document, '\D', '', 'g')) stored,
  email text,
  phone text,
  address text,
  address_number text,
  address_complement text,
  neighborhood text,
  city text,
  state char(2),
  zip_code text,
  notes text,
  client_profile_id uuid,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bureau_id, id),
  constraint holders_document_unique unique (bureau_id, document_digits),
  constraint holders_document_length check (
    (type = 'PF' and length(document_digits) = 11)
    or (type = 'PJ' and length(document_digits) = 14)),
  foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id)
);

-- Sociedade: empresa (company_id) e sócio (partner_id).
create table holder_partnerships (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  company_id uuid not null,
  partner_id uuid not null,
  percentage numeric(5,2) check (percentage between 0 and 100),
  role text,
  source text not null check (source in ('deps', 'operator')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, partner_id),
  check (company_id <> partner_id),
  foreign key (bureau_id, company_id) references holders (bureau_id, id),
  foreign key (bureau_id, partner_id) references holders (bureau_id, id)
);

-- Dossiê. Os campos do parecer consolidado vêm do antigo company_reports.
create table dossiers (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  kind dossier_kind not null,
  holder_id uuid not null,
  product text not null,
  status dossier_status not null default 'pending',
  created_by uuid not null references profiles(id),
  started_at timestamptz,
  completed_at timestamptz,
  report_status text not null default 'none'
    check (report_status in ('none', 'generating', 'completed', 'error')),
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bureau_id, id),
  foreign key (bureau_id, holder_id) references holders (bureau_id, id)
);

create table consultations (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  type query_type not null,
  document text not null,
  document_name text,
  product text,
  holder_id uuid not null,
  dossier_id uuid not null,
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
  updated_at timestamptz not null default now(),
  unique (bureau_id, id),
  foreign key (bureau_id, holder_id) references holders (bureau_id, id),
  foreign key (bureau_id, dossier_id) references dossiers (bureau_id, id)
);

create table scr_authorizations (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  document text not null,
  type query_type not null,
  name text,
  email text,
  consultation_id uuid,
  holder_id uuid not null,
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
  updated_at timestamptz not null default now(),
  foreign key (bureau_id, holder_id) references holders (bureau_id, id),
  foreign key (bureau_id, consultation_id) references consultations (bureau_id, id)
    on delete set null (consultation_id)
);

create table bureau_payloads (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  consultation_id uuid not null,
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
  unique (consultation_id, payload_sha256),
  unique (bureau_id, id),
  foreign key (bureau_id, consultation_id) references consultations (bureau_id, id)
    on delete cascade
);

create table bureau_results (
  bureau_id uuid not null,
  consultation_id uuid primary key,
  payload_id uuid not null unique,
  adapter_version integer not null check (adapter_version > 0),
  canonical_result jsonb not null,
  document text not null,
  person_name text,
  score integer,
  risk_level text,
  created_at timestamptz not null default now(),
  foreign key (bureau_id, consultation_id) references consultations (bureau_id, id)
    on delete cascade,
  foreign key (bureau_id, payload_id) references bureau_payloads (bureau_id, id)
);

create table ai_reports (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  consultation_id uuid not null unique,
  holder_id uuid,
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
  updated_at timestamptz not null default now(),
  foreign key (bureau_id, consultation_id) references consultations (bureau_id, id)
    on delete cascade,
  foreign key (bureau_id, holder_id) references holders (bureau_id, id)
    on delete set null (holder_id)
);

create table timeline_events (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
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
  bureau_id uuid not null references bureaus(id),
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

-- Sessão de suporte: o superadmin só lê dados de tenant com uma sessão ativa
-- (app_support_active em 004). Vale no máximo 1 hora.
create table support_sessions (
  id uuid primary key default gen_random_uuid(),
  superadmin_id uuid not null references profiles(id),
  bureau_id uuid not null references bureaus(id),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  ended_at timestamptz,
  check (expires_at > started_at and expires_at <= started_at + interval '1 hour'),
  check (ended_at is null or ended_at >= started_at)
);

-- bureau_id nulo = evento da plataforma.
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid references bureaus(id),
  support_session_id uuid references support_sessions(id),
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
create trigger bureaus_updated_at before update on bureaus
  for each row execute function set_updated_at();
create trigger holders_updated_at before update on holders
  for each row execute function set_updated_at();
create trigger holder_partnerships_updated_at before update on holder_partnerships
  for each row execute function set_updated_at();
create trigger dossiers_updated_at before update on dossiers
  for each row execute function set_updated_at();
create trigger consultations_updated_at before update on consultations
  for each row execute function set_updated_at();
create trigger scr_authorizations_updated_at before update on scr_authorizations
  for each row execute function set_updated_at();
create trigger ai_reports_updated_at before update on ai_reports
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
alter type dossier_kind owner to schema_owner;
alter type dossier_status owner to schema_owner;
alter type scr_status owner to schema_owner;
alter type timeline_entity_type owner to schema_owner;
alter function set_updated_at() owner to schema_owner;
alter function enforce_bureau_payload_transition() owner to schema_owner;

alter table bureaus owner to schema_owner;
alter table profiles owner to schema_owner;
alter table holders owner to schema_owner;
alter table holder_partnerships owner to schema_owner;
alter table dossiers owner to schema_owner;
alter table consultations owner to schema_owner;
alter table scr_authorizations owner to schema_owner;
alter table bureau_payloads owner to schema_owner;
alter table bureau_results owner to schema_owner;
alter table ai_reports owner to schema_owner;
alter table timeline_events owner to schema_owner;
alter table crm_notes owner to schema_owner;
alter table settings owner to schema_owner;
alter table support_sessions owner to schema_owner;
alter table audit_logs owner to schema_owner;
