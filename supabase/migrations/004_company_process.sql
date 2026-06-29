-- ============================================================
-- 004 — Processamento de empresa (Fase 5)
-- Reutiliza `batches` como container do processo (CNPJ + sócios) e
-- adiciona `company_reports` para o parecer técnico consolidado do
-- quadro societário (espelha as colunas de parecer de `ai_reports`).
-- Aditiva e não-destrutiva.
-- ============================================================

-- CNPJ do processo (a empresa analisada). Membros continuam via queries.batch_id.
alter table batches
  add column if not exists document text;

-- ============================================================
-- COMPANY_REPORTS — parecer consolidado por processo (batch)
-- Um por batch. Escrita via service-role (sem policy de insert/update),
-- igual a ai_reports.
-- ============================================================

create table if not exists company_reports (
  id                    uuid primary key default uuid_generate_v4(),
  batch_id              uuid not null unique references batches(id) on delete cascade,

  -- Classificação principal
  aptitude_status       text not null default 'pending',
  -- pending | apt | apt_with_caveats | inapt

  -- Parecer estruturado (mesma forma de ai_reports)
  executive_summary     text,
  positive_points       jsonb,
  risk_points           jsonb,
  action_plan           jsonb,
  suggested_products    jsonb,
  suggested_limit       numeric(15,2),
  suggested_limit_notes text,
  report_markdown       text,   -- parecer completo em markdown
  full_report           jsonb,  -- objeto Parecer completo

  -- Controle de geração
  model_used            text,
  prompt_version        text,
  generated_at          timestamptz,
  generation_error      text,

  -- Status do parecer
  status                text not null default 'generating',
  -- generating | completed | error

  created_by            uuid references profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_company_reports_batch on company_reports(batch_id);

drop trigger if exists trg_company_reports_updated_at on company_reports;
create trigger trg_company_reports_updated_at
  before update on company_reports
  for each row execute function set_updated_at();

alter table company_reports enable row level security;

-- staff lê; escrita via service-role (sem policy de insert/update), como ai_reports
drop policy if exists "company_reports: staff lê" on company_reports;
create policy "company_reports: staff lê" on company_reports for select
  using (auth_role() in ('admin', 'consultant'));
