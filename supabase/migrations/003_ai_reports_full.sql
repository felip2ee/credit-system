-- ============================================================
-- 003 — Parecer de IA completo (Fase 3)
-- Adiciona o relatório completo (23 seções) e o JSON estruturado
-- do parecer à tabela ai_reports. As colunas estruturadas que já
-- existem (executive_summary, positive_points, etc.) continuam sendo
-- preenchidas para consulta/relatórios; estas duas guardam o parecer
-- na íntegra para exibição e export.
-- ============================================================

alter table ai_reports
  add column if not exists report_markdown text,   -- parecer completo em markdown (23 seções)
  add column if not exists full_report     jsonb;  -- objeto Parecer completo (notas, ranking, etc.)
