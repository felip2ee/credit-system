-- M2: o superadmin (sem suporte) grava a auditoria de custo com o bureau_id do Bureau alvo.
-- Exceção estreita à política de 004: só a ação catalog.cost.set, só superadmin sem sessão de suporte,
-- e só junto de uma linha de custo gravada na mesma transação, com o mesmo Bureau, produto e autor
-- e com metadata.new_cost igual ao custo gravado. Garante: o evento aponta para um custo real e o valor
-- auditado é o valor gravado. Não garante: os demais campos de metadata (ex.: old_cost), nem que exista
-- só um evento por linha de custo (a mesma transação pode gravar mais de um).
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
      and table_name = 'products'
      and exists (
        select 1 from bureau_product_costs c
         where c.bureau_id = audit_logs.bureau_id
           and c.product_id = audit_logs.record_id
           and c.set_by = audit_logs.user_id
           and c.created_at = now()
           and (audit_logs.metadata ->> 'new_cost')::numeric = c.cost
      )
    )
  ));

-- O superadmin relê os eventos de custo (bureau_id preenchido, sem suporte), como política adicional ao 004.
create policy audit_logs_select_cost on audit_logs for select using (
  app_context_present()
  and app_user_role() = 'superadmin'
  and support_session_id is null
  and bureau_id is not null
  and action = 'catalog.cost.set'
);

create index audit_logs_cost_idx
  on audit_logs(created_at desc)
  where action = 'catalog.cost.set' and support_session_id is null and bureau_id is not null;
