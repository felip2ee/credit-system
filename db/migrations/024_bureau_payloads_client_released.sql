-- Portal do cliente (spec 2026-10-19 consulta completa): o cliente lê o payload bruto da deps só de pedido próprio em
-- 'released'. Espelho de bureau_results_client_released (022), com a junção em bureau_payloads.consultation_id.
-- Substitui a decisão D23 da 022 ("sem política de cliente em bureau_payloads"). app_runtime já tem select (004).
drop policy if exists bureau_payloads_client_released on bureau_payloads;
create policy bureau_payloads_client_released on bureau_payloads for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = bureau_payloads.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));
