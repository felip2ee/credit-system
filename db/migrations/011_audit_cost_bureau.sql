-- M2: o superadmin (sem suporte) grava a auditoria de custo com o bureau_id do Bureau alvo.
-- Exceção estreita à política de 004: só a ação catalog.cost.set, só superadmin sem sessão de suporte.
-- Todas as outras linhas seguem a regra anterior (bureau_id nulo para o superadmin sem suporte).
drop policy audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs for insert with check (
  app_context_present()
  and user_id = app_user_id()
  and support_session_id is not distinct from app_support_session_id()
  and (
    (
      bureau_id is not distinct from app_bureau_id()
      and (bureau_id is null) = (app_user_role() = 'superadmin' and app_support_session_id() is null)
    )
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and action = 'catalog.cost.set'
    )
  ));
