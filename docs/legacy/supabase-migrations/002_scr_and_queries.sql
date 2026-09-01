-- ============================================================
-- Reino do Crédito — Migration 002: SCR + vínculo de consultas ao CRM
-- Aditiva e não-destrutiva.
-- ============================================================

-- queries: passa a referenciar o cliente do CRM (crm_clients).
-- A coluna antiga client_id (→ clients) permanece por compatibilidade.
alter table queries
  add column if not exists crm_client_id uuid references crm_clients(id) on delete set null;

create index if not exists idx_queries_crm_client on queries(crm_client_id);

-- ============================================================
-- SCR_AUTHORIZATIONS
-- Status do consentimento SCR por documento (fluxo de aceite via deps).
-- ============================================================

do $$ begin
  create type scr_status as enum ('pending', 'authorized', 'not_authorized', 'expired');
exception when duplicate_object then null; end $$;

create table if not exists scr_authorizations (
  id              uuid primary key default uuid_generate_v4(),
  document        text not null,
  type            query_type not null,
  name            text,
  email           text,
  query_id        uuid references queries(id) on delete set null,
  crm_client_id   uuid references crm_clients(id) on delete set null,
  status          scr_status not null default 'pending',
  requested_by    uuid references profiles(id) on delete set null,
  requested_at    timestamptz not null default now(),
  authorized_at   timestamptz,
  expires_at      timestamptz,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_scr_document on scr_authorizations(document);
create index if not exists idx_scr_status   on scr_authorizations(status);
create index if not exists idx_scr_client   on scr_authorizations(crm_client_id);

drop trigger if exists trg_scr_updated_at on scr_authorizations;
create trigger trg_scr_updated_at
  before update on scr_authorizations
  for each row execute function set_updated_at();

alter table scr_authorizations enable row level security;

drop policy if exists "scr_auth: staff" on scr_authorizations;
create policy "scr_auth: staff" on scr_authorizations for all
  using (auth_role() in ('admin', 'consultant'));
