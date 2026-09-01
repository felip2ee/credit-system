-- ============================================================
-- 009 — Portal do Cliente (Fase 6)
-- Habilita o acesso do papel `client` ao portal externo:
-- ele acompanha as próprias oportunidades e envia documentos.
--
-- Princípio: o portal expõe SOMENTE oportunidades, seus documentos
-- e a timeline da oportunidade. NÃO expõe dados de bureau, consultas
-- nem o parecer interno de IA. Como ainda não existe nenhum usuário
-- com papel `client`, este é o momento de fechar as políticas amplas
-- herdadas do desenho original ("portal futuro") antes do onboarding.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) HARDENING — remove leituras de `client` sobre dados sensíveis
--    Estas políticas existiam desde a migration 001 mas nunca foram
--    exercidas (não há usuário client). Removidas para evitar que um
--    cliente, com o próprio JWT, leia bureau/parecer via API REST.
-- ────────────────────────────────────────────────────────────

drop policy if exists "queries: client lê próprias"      on queries;
drop policy if exists "results_pj: client lê próprio"     on query_results_pj;
drop policy if exists "results_pf: client lê próprio"     on query_results_pf;
drop policy if exists "ai_reports: client lê próprio"     on ai_reports;

-- ────────────────────────────────────────────────────────────
-- 2) TIMELINE — restringe a leitura do cliente às oportunidades dele
--    A política antiga permitia `auth_role() = 'client'` sem filtro de
--    linha (com a ressalva "filtro adicional via app"), o que na prática
--    deixava qualquer cliente ler TODA a timeline via API. Agora o
--    cliente só lê eventos das oportunidades das quais é titular.
-- ────────────────────────────────────────────────────────────

drop policy if exists "timeline: client lê própria" on timeline_events;
create policy "timeline: client lê própria" on timeline_events for select
  using (
    auth_role() = 'client'
    and entity_type = 'opportunity'
    and entity_id in (
      select o.id
      from opportunities o
      join crm_clients c on c.id = o.crm_client_id
      where c.user_id = auth.uid()
    )
  );

-- ────────────────────────────────────────────────────────────
-- 3) DOCUMENTOS DA OPORTUNIDADE — leitura do cliente
--    O cliente lê (apenas SELECT) o checklist das oportunidades dele.
--    A escrita (registro do upload) é feita por Server Action com
--    service-role, após validar a posse — por isso não há policy de
--    insert/update para o cliente aqui.
-- ────────────────────────────────────────────────────────────

drop policy if exists "opp_docs: client lê próprios" on opportunity_documents;
create policy "opp_docs: client lê próprios" on opportunity_documents for select
  using (
    auth_role() = 'client'
    and opportunity_id in (
      select o.id
      from opportunities o
      join crm_clients c on c.id = o.crm_client_id
      where c.user_id = auth.uid()
    )
  );

-- ────────────────────────────────────────────────────────────
-- 4) CATÁLOGO DE PRODUTOS — leitura do cliente
--    Necessário só para exibir o nome do produto na oportunidade.
--    Catálogo não sensível.
-- ────────────────────────────────────────────────────────────

drop policy if exists "credit_products: client lê" on credit_products;
create policy "credit_products: client lê" on credit_products for select
  using (auth_role() = 'client');

-- ────────────────────────────────────────────────────────────
-- Observações
-- • crm_clients: a leitura própria do cliente já existe (migration 001).
-- • opportunities: a leitura própria do cliente já existe (migration 001).
-- • Storage (bucket opportunity-docs): o cliente NÃO recebe policy de
--   storage. Upload e download do portal passam por Server Action com
--   service-role que valida a posse da oportunidade (actions/portal.ts).
-- ────────────────────────────────────────────────────────────
