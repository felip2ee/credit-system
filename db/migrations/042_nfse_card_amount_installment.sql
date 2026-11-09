-- NFS-e no cartão: valor da nota = o que o pagador pagou, e nota única do parcelamento.
-- nfse_charge_by_payment (webhook) e nfse_charge_payment (superadmin, nova tentativa) passam a devolver
-- amount = coalesce(total_charged, amount) e asaas_installment_id (só em cartão com 2x ou mais).
-- O tipo de retorno muda, então as funções são recriadas (sem editar a 017/019 já aplicadas).
drop function nfse_charge_by_payment(text);
create function nfse_charge_by_payment(p_asaas_payment_id text)
returns table (charge_id uuid, amount numeric, asaas_invoice_id text, asaas_installment_id text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.id, coalesce(c.total_charged, c.amount), c.asaas_invoice_id, c.asaas_installment_id
    from public.pix_charges c
   where c.asaas_payment_id = p_asaas_payment_id
     and c.status = 'paid'
$$;
alter function nfse_charge_by_payment(text) owner to auth_profile_lookup;
revoke all on function nfse_charge_by_payment(text) from public, app_runtime;
grant execute on function nfse_charge_by_payment(text) to app_webhook;

drop function nfse_charge_payment(uuid);
create function nfse_charge_payment(p_charge_id uuid)
returns table (asaas_payment_id text, amount numeric, bureau_id uuid, asaas_installment_id text)
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
    select c.asaas_payment_id, coalesce(c.total_charged, c.amount), c.bureau_id, c.asaas_installment_id
      from public.pix_charges c
     where c.id = p_charge_id
       and c.status = 'paid'
       and (c.nfse_status = 'failed' or (c.nfse_status = 'pending' and c.nfse_attempts > 0));
end
$$;
alter function nfse_charge_payment(uuid) owner to auth_profile_lookup;
revoke all on function nfse_charge_payment(uuid) from public;
grant execute on function nfse_charge_payment(uuid) to app_runtime;
