-- ============================================================
-- Conferência das migrations 001..011
--
-- Não existe tabela de controle (as migrations são aplicadas direto via SQL),
-- então a verificação é por OBJETO: cada linha checa algo que uma migration
-- específica deveria ter criado. Rode no SQL Editor do Supabase.
--
-- Leitura do resultado:
--   status = 'OK'        → objeto presente
--   status = 'FALTANDO'  → a migration daquela linha não rodou (ou rodou parcial)
--
-- Para ver só os problemas, descomente o WHERE no final.
-- ============================================================

with
-- Tabelas criadas por cada migration
expected_tables(mig, obj) as (values
  ('001', 'profiles'), ('001', 'clients'), ('001', 'batches'), ('001', 'queries'),
  ('001', 'query_results_pj'), ('001', 'query_results_pf'), ('001', 'authorizations'),
  ('001', 'notifications'), ('001', 'audit_logs'), ('001', 'settings'),
  ('001', 'credit_products'), ('001', 'crm_clients'), ('001', 'crm_client_documents'),
  ('001', 'crm_client_relations'), ('001', 'ai_reports'), ('001', 'opportunities'),
  ('001', 'opportunity_documents'), ('001', 'timeline_events'), ('001', 'crm_notes'),
  ('002', 'scr_authorizations'),
  ('004', 'company_reports')
),

-- Enums (tipos) criados
expected_types(mig, obj) as (values
  ('001', 'user_role'), ('001', 'query_type'), ('001', 'query_status'),
  ('001', 'batch_status'), ('001', 'authorization_action'),
  ('002', 'scr_status')
),

-- Colunas adicionadas por migrations posteriores (o coração da checagem)
expected_columns(mig, tbl, col) as (values
  ('002', 'queries',            'crm_client_id'),
  ('003', 'ai_reports',         'report_markdown'),
  ('003', 'ai_reports',         'full_report'),
  ('004', 'batches',            'document'),
  ('005', 'queries',            'scr_email'),
  ('008', 'scr_authorizations', 'channel'),
  ('008', 'scr_authorizations', 'auth_code'),
  ('008', 'scr_authorizations', 'public_token'),
  ('008', 'scr_authorizations', 'consent_text'),
  ('008', 'scr_authorizations', 'consented_at'),
  ('008', 'scr_authorizations', 'refused_at'),
  ('011', 'queries',            'scr_mode')
),

-- Seeds na tabela settings
expected_settings(mig, key) as (values
  ('008', 'scr_authorized_name'),
  ('008', 'scr_authorized_document'),
  ('008', 'scr_institution_name'),
  ('008', 'scr_city'),
  ('010', 'default_commission_rate')
),

-- Policies de RLS que devem EXISTIR
expected_policies(mig, tbl, pol) as (values
  ('009', 'timeline_events',       'timeline: client lê própria'),
  ('009', 'opportunity_documents', 'opp_docs: client lê próprios'),
  ('009', 'credit_products',       'credit_products: client lê')
),

-- Policies que a 009 REMOVEU (hardening: o portal não vê consulta/parecer).
-- Aqui "OK" significa que a policy NÃO existe mais.
dropped_policies(mig, tbl, pol) as (values
  ('009', 'queries',          'queries: client lê próprias'),
  ('009', 'query_results_pj', 'results_pj: client lê próprio'),
  ('009', 'query_results_pf', 'results_pf: client lê próprio'),
  ('009', 'ai_reports',       'ai_reports: client lê próprio')
)

select mig as migration, item, status from (
  -- Tabelas
  select t.mig, 'tabela ' || t.obj as item,
         case when to_regclass('public.' || t.obj) is not null then 'OK' else 'FALTANDO' end as status
  from expected_tables t

  union all
  -- Tipos / enums
  select t.mig, 'tipo ' || t.obj,
         case when exists (select 1 from pg_type where typname = t.obj) then 'OK' else 'FALTANDO' end
  from expected_types t

  union all
  -- Colunas
  select c.mig, 'coluna ' || c.tbl || '.' || c.col,
         case when exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = c.tbl and column_name = c.col
         ) then 'OK' else 'FALTANDO' end
  from expected_columns c

  union all
  -- Seeds de settings
  select s.mig, 'setting ' || s.key,
         case when exists (select 1 from settings where key = s.key) then 'OK' else 'FALTANDO' end
  from expected_settings s

  union all
  -- Bucket do Storage (007)
  select '007', 'bucket opportunity-docs',
         case when exists (select 1 from storage.buckets where id = 'opportunity-docs')
              then 'OK' else 'FALTANDO' end

  union all
  -- Produtos em escopo (010)
  select '010', 'produto ativo Financiamento Imobiliário',
         case when exists (
           select 1 from credit_products
           where name = 'Financiamento Imobiliário' and is_active
         ) then 'OK' else 'FALTANDO' end
  union all
  select '010', 'produto ativo Capital de Giro',
         case when exists (
           select 1 from credit_products where name = 'Capital de Giro' and is_active
         ) then 'OK' else 'FALTANDO' end
  union all
  select '010', 'demais produtos desativados',
         case when not exists (
           select 1 from credit_products
           where is_active and name not in ('Capital de Giro', 'Financiamento Imobiliário')
         ) then 'OK' else 'FALTANDO' end

  union all
  -- Policies que devem existir
  select p.mig, 'policy ' || p.tbl || ' → ' || p.pol,
         case when exists (
           select 1 from pg_policies
           where schemaname = 'public' and tablename = p.tbl and policyname = p.pol
         ) then 'OK' else 'FALTANDO' end
  from expected_policies p

  union all
  -- Policies que a 009 deve ter REMOVIDO (presença = hardening não aplicado)
  select d.mig, 'policy REMOVIDA ' || d.tbl || ' → ' || d.pol,
         case when not exists (
           select 1 from pg_policies
           where schemaname = 'public' and tablename = d.tbl and policyname = d.pol
         ) then 'OK' else 'FALTANDO' end
  from dropped_policies d

  union all
  -- RLS ligado em todas as tabelas do app (001 em diante)
  select '001', 'RLS habilitado em ' || c.relname,
         case when c.relrowsecurity then 'OK' else 'FALTANDO' end
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in (
      'profiles','clients','queries','query_results_pj','query_results_pf',
      'authorizations','batches','notifications','audit_logs','settings',
      'crm_clients','ai_reports','opportunities','opportunity_documents',
      'timeline_events','scr_authorizations','company_reports'
    )
) checks
-- where status = 'FALTANDO'   -- ← descomente para ver só o que falta
order by migration, status desc, item;
