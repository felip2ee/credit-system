-- ============================================================
-- 006 — Correção de RLS da timeline_events (vazamento p/ role 'client')
-- A política original liberava QUALQUER usuário 'client' a ler a timeline
-- de TODOS os clientes (o comentário "filtro via app" não é garantia de
-- segurança — o RLS existe justamente para não depender da aplicação).
-- Aqui restringimos o 'client' a ver apenas eventos das entidades ligadas
-- aos seus próprios crm_clients (espelha ai_reports / opportunities).
-- Aditiva e não-destrutiva (substitui só a policy problemática).
-- ============================================================

drop policy if exists "timeline: client lê própria" on timeline_events;

create policy "timeline: client lê própria" on timeline_events for select
  using (
    auth_role() = 'client'
    and (
      -- Eventos do próprio cliente CRM
      (entity_type = 'crm_client' and entity_id in (
        select id from crm_clients where user_id = auth.uid()
      ))
      -- Eventos de oportunidades dos seus clientes CRM
      or (entity_type = 'opportunity' and entity_id in (
        select o.id from opportunities o
        join crm_clients c on c.id = o.crm_client_id
        where c.user_id = auth.uid()
      ))
      -- Eventos de consultas vinculadas aos seus clientes CRM
      or (entity_type = 'query' and entity_id in (
        select q.id from queries q
        join crm_clients c on c.id = q.crm_client_id
        where c.user_id = auth.uid()
      ))
    )
  );
