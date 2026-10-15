-- M3b: fecha duas lacunas da 016. A 015–020 são base editável até o primeiro deploy em produção: a branch edita a
-- 016–019 no lugar. Banco de dev que já aplicou uma versão antiga precisa de npm run db:reset após o pull.
-- 1) Três funções de consulta da NFS-e:
--    nfse_charge_by_payment (app_webhook): liga o id do pagamento do Asaas ao id da cobrança, que set_nfse_status exige.
--    nfse_charge_payment (superadmin sem suporte): devolve o id do pagamento do Asaas, o valor e o Bureau para a nova
--    tentativa da nota (o Bureau alvo vai na auditoria do nfse.retry).
--    nfse_charge_by_invoice (app_webhook): liga o id da nota do Asaas (pix_charges.asaas_invoice_id) à cobrança.
--    O id do pagamento do Asaas não sai para nenhuma outra role.
-- 2) Auditoria com bureau_id alvo para payout.create, payout.pay, payout.cancel e nfse.retry (superadmin sem suporte).

-- Webhook: cobrança paga ou estornada do pagamento. Sem linha = pagamento desconhecido ou ainda não pago.
-- Só id, valor e o id da nota gravada (o webhook ignora evento de outra nota): nada do Bureau.
create function nfse_charge_by_payment(p_asaas_payment_id text)
returns table (charge_id uuid, amount numeric, asaas_invoice_id text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.amount, c.asaas_invoice_id
    from public.pix_charges c
   where c.asaas_payment_id = p_asaas_payment_id
     and c.status in ('paid', 'refunded')
$$;

-- Webhook da nota: liga o id da nota do Asaas (asaas_invoice_id) à cobrança. Sem filtro de status: a nota já existe e
-- o evento dela vale mesmo se a cobrança foi estornada depois. Só id e valor: nada do Bureau.
create function nfse_charge_by_invoice(p_asaas_invoice_id text)
returns table (charge_id uuid, amount numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.amount
    from public.pix_charges c
   where c.asaas_invoice_id = p_asaas_invoice_id
$$;

-- Nova tentativa: só superadmin sem suporte, só de cobrança paga. A nota 'failed' ainda não tentada de novo e a 'pending' que a nova
-- tentativa acabou de criar (nfse_attempts > 0, depois de request_nfse_retry); as demais não têm o que reenviar.
create function nfse_charge_payment(p_charge_id uuid)
returns table (asaas_payment_id text, amount numeric, bureau_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return;
  end if;
  return query
    select c.asaas_payment_id, c.amount, c.bureau_id
      from public.pix_charges c
     where c.id = p_charge_id
       and c.status = 'paid'
       and (c.nfse_status = 'failed' or (c.nfse_status = 'pending' and c.nfse_attempts > 0));
end
$$;

-- Prova do nfse.retry para a política de auditoria: o superadmin não lê pix_charges. Devolve só um booleano:
-- a cobrança é do Bureau informado e a última escrita nela é desta transação, com a nota 'pending' e uma tentativa
-- contada (o efeito de request_nfse_retry). Fora do superadmin sem suporte devolve sempre falso.
create function audit_nfse_retry_backed(p_charge_id uuid, p_bureau_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return false;
  end if;
  return exists (
    select 1 from public.pix_charges c
     where c.id = p_charge_id
       and c.bureau_id = p_bureau_id
       and c.nfse_status = 'pending'
       and c.nfse_attempts > 0
       and c.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid
  );
end
$$;

alter function nfse_charge_by_payment(text) owner to auth_profile_lookup;
alter function nfse_charge_by_invoice(text) owner to auth_profile_lookup;
alter function nfse_charge_payment(uuid) owner to auth_profile_lookup;
alter function audit_nfse_retry_backed(uuid, uuid) owner to auth_profile_lookup;

revoke all on function nfse_charge_by_payment(text) from public, app_runtime;
revoke all on function nfse_charge_by_invoice(text) from public, app_runtime;
revoke all on function nfse_charge_payment(uuid) from public;
revoke all on function audit_nfse_retry_backed(uuid, uuid) from public;
grant execute on function nfse_charge_by_payment(text) to app_webhook;
grant execute on function nfse_charge_by_invoice(text) to app_webhook;
grant execute on function nfse_charge_payment(uuid) to app_runtime;
grant execute on function audit_nfse_retry_backed(uuid, uuid) to app_runtime;

-- Auditoria: mantém os ramos catalog.cost.set (011) e wallet.adjust (012) sem mudança e acrescenta payout.* e
-- nfse.retry. Só superadmin sem suporte, com bureau_id alvo, e só junto da linha que a mesma transação escreveu
-- (xmin da última versão da linha = transação atual): o evento aponta para uma mudança real do Bureau informado.
-- payout.create: repasse aberto criado por este autor. payout.pay: repasse pago por este autor. payout.cancel: repasse
-- cancelado (a tabela não guarda o autor do cancelamento). nfse.retry: ver audit_nfse_retry_backed.
-- Não garante: os campos de metadata, nem um só evento por linha (a mesma transação pode gravar mais de um).
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
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and action = 'wallet.adjust'
      and table_name = 'ledger_entries'
      and exists (
        select 1 from ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'adjustment'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and table_name = 'payouts'
      and action in ('payout.create', 'payout.pay', 'payout.cancel')
      and exists (
        select 1 from payouts p
         where p.id = audit_logs.record_id
           and p.bureau_id = audit_logs.bureau_id
           and p.xmin = pg_current_xact_id()::xid
           and (
             (audit_logs.action = 'payout.create' and p.status = 'open' and p.created_by = audit_logs.user_id)
             or (audit_logs.action = 'payout.pay' and p.status = 'paid' and p.paid_by = audit_logs.user_id)
             or (audit_logs.action = 'payout.cancel' and p.status = 'cancelled')
           )
      )
    )
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and action = 'nfse.retry'
      and table_name = 'pix_charges'
      and audit_nfse_retry_backed(audit_logs.record_id, audit_logs.bureau_id)
    )
  ));

-- O superadmin relê esses eventos (bureau_id preenchido, sem suporte), como política adicional ao 004.
-- O bureau_admin do Bureau alvo já os lê pela audit_logs_select do 004.
create policy audit_logs_select_payout_nfse on audit_logs for select using (
  app_context_present()
  and app_user_role() = 'superadmin'
  and support_session_id is null
  and bureau_id is not null
  and action in ('payout.create', 'payout.pay', 'payout.cancel', 'nfse.retry')
);
