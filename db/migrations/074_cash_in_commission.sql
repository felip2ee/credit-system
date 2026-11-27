-- Comissão sobre a entrada de dinheiro (plano afiliado-bureaus, parte 1, task 3).
-- 1) affiliate_wallet_post_entry ganha p_origin ('order' padrão, 'cash_in'): grava affiliate_ledger_entries.origin (070).
--    Os chamadores antigos (seis argumentos) seguem valendo pelo padrão. A assinatura antiga sai (com o padrão as duas
--    ficariam ambíguas). O corpo é o da 026 mais a coluna origin; dono e grants ficam como eram (interna, sem app_runtime).
--    Os lançamentos de liberação e reversão feitos depois por release_due_commissions ficam com origin 'order'.
-- 2) bureau_payable_entries: o accrual do bureau sem walletId (C2) e o do bureau indicador sem walletId apontam para a
--    cobrança (pix_charge_id). Um accrual por cobrança e bureau.
-- 3) record_cash_in_commission(charge): na confirmação do pagamento grava os repasses que não passam pelo split do Asaas:
--    afiliado em modo Pix (affiliate_commissions com order_ref = cobrança, lançamento cash_in, carência de
--    affiliate_cash_in_hold_days; carência 0 libera na hora) e accrual de bureau sem walletId. Idempotente: só trata linha
--    pending e a marca done; chaves únicas do livro-razão e dos accruals são a segunda barreira.
--    Roda dentro de apply_asaas_payment (075), na mesma transação que marca a cobrança como paga.

drop function affiliate_wallet_post_entry(uuid, text, numeric, text, text, uuid);

create function affiliate_wallet_post_entry(
  p_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_created_by uuid,
  p_origin text default 'order'
)
returns table (ok boolean, reason text, entry_id uuid, pending numeric, available numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau_id uuid;
  v_pending numeric;
  v_available numeric;
  v_pending_after numeric;
  v_available_after numeric;
  v_entry public.affiliate_ledger_entries;
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
       'commission', 'commission_release', 'commission_reversal', 'conversion',
       'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, pending, available into v_bureau_id, v_pending, v_available
    from public.affiliate_wallets where profile_id = p_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.affiliate_ledger_entries
   where profile_id = p_profile_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.pending_after, v_entry.available_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_pending_after := v_pending;
  v_available_after := v_available;
  case p_kind
    when 'commission' then
      v_pending_after := v_pending + p_amount;
    when 'commission_release' then
      v_pending_after := v_pending - p_amount;
      v_available_after := v_available + p_amount;
    when 'commission_reversal' then
      v_pending_after := v_pending - p_amount;
    when 'conversion', 'withdrawal_hold' then
      v_available_after := v_available - p_amount;
    when 'withdrawal_release' then
      v_available_after := v_available + p_amount;
    when 'withdrawal_paid' then
      null; -- só registro: o valor já saiu do disponível em withdrawal_hold
  end case;

  if v_pending_after < 0 or v_available_after < 0 then
    return query select false, 'insufficient_funds'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.affiliate_ledger_entries
    (profile_id, bureau_id, kind, amount, pending_after, available_after, idempotency_key, reference, created_by, origin)
  values
    (p_profile_id, v_bureau_id, p_kind, p_amount, v_pending_after, v_available_after, p_idempotency_key,
     p_reference, p_created_by, p_origin)
  returning id into v_id;
  update public.affiliate_wallets set pending = v_pending_after, available = v_available_after
   where profile_id = p_profile_id;

  return query select true, null::text, v_id, v_pending_after, v_available_after, false;
end
$$;

alter function affiliate_wallet_post_entry(uuid, text, numeric, text, text, uuid, text) owner to auth_profile_lookup;
revoke all on function affiliate_wallet_post_entry(uuid, text, numeric, text, text, uuid, text) from public, app_runtime;

-- O accrual da entrada aponta para a cobrança no lugar do pedido (018: accrual exigia order_ref).
alter table bureau_payable_entries drop constraint bureau_payable_entries_accrual_order;
alter table bureau_payable_entries add constraint bureau_payable_entries_accrual_order
  check (kind <> 'accrual' or order_ref is not null or pix_charge_id is not null);
alter table bureau_payable_entries drop constraint bureau_payable_entries_charge_link;
alter table bureau_payable_entries add constraint bureau_payable_entries_charge_link
  check (kind in ('reversal', 'accrual') or pix_charge_id is null);
create unique index bureau_payable_entries_accrual_charge_idx on bureau_payable_entries(pix_charge_id, bureau_id)
  where kind = 'accrual' and pix_charge_id is not null;

-- Auditoria do accrual: sem sessão, sobre o lançamento do mesmo bureau.
create policy audit_logs_cash_in_accrual_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'payable.cash_in_accrual'
  and support_session_id is null
  and table_name = 'bureau_payable_entries'
  and bureau_id is not null
  and exists (
    select 1 from bureau_payable_entries e where e.id = audit_logs.record_id and e.bureau_id = audit_logs.bureau_id)
);

create function record_cash_in_commission(p_charge_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_charge public.pix_charges;
  v_line public.charge_splits;
  v_post record;
  v_entry_id uuid;
  v_commission_id uuid;
  v_hold integer;
  v_amount numeric;
  v_done integer := 0;
begin
  select * into v_charge from public.pix_charges where id = p_charge_id for share;
  if not found or v_charge.status <> 'paid' then
    return 0;
  end if;
  select greatest(floor((value #>> '{}')::numeric)::integer, 0) into v_hold
    from public.settings where key = 'affiliate_cash_in_hold_days' and jsonb_typeof(value) = 'number';
  v_hold := coalesce(v_hold, 0);

  for v_line in
    select * from public.charge_splits s
     where s.pix_charge_id = p_charge_id and s.payout_method in ('pix', 'accrual') and s.status = 'pending'
     order by s.id
       for update
  loop
    v_amount := v_line.amount_cents::numeric / 100;

    if v_line.beneficiary_kind in ('bureau', 'bureau_referrer') then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, pix_charge_id)
      values (v_line.beneficiary_id, 'accrual', v_amount, p_charge_id)
      on conflict (pix_charge_id, bureau_id) where kind = 'accrual' and pix_charge_id is not null do nothing
      returning id into v_entry_id;
      if v_entry_id is not null then
        insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
        values (v_line.beneficiary_id, null, 'payable.cash_in_accrual', 'bureau_payable_entries', v_entry_id,
          jsonb_build_object('pix_charge_id', p_charge_id, 'kind', v_line.beneficiary_kind,
            'pct', v_line.pct::text, 'amount', v_amount::text));
      end if;
    elsif v_line.beneficiary_kind = 'affiliate' and v_line.payout_method = 'pix' then
      -- Conta anonimizada ou desligada depois do plano: a parte fica com a plataforma. Mesma trava da captura.
      perform 1 from public.profiles a
       where a.id = v_line.beneficiary_id and a.anonymized_at is null and a.is_active for share;
      if not found then
        update public.charge_splits set status = 'refused' where id = v_line.id;
        continue;
      end if;
      insert into public.affiliate_commissions
        (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, release_at)
      values
        (p_charge_id, v_charge.bureau_id, v_line.beneficiary_id, v_charge.client_profile_id, v_line.pct,
         v_charge.amount, v_amount, now() + make_interval(days => v_hold))
      on conflict (order_ref) do nothing
      returning id into v_commission_id;
      if v_commission_id is not null then
        select * into v_post from public.affiliate_wallet_post_entry(
          v_line.beneficiary_id, 'commission', v_amount, 'cashin:commission:' || p_charge_id::text,
          'commission:' || v_commission_id::text, v_line.beneficiary_id, 'cash_in');
        if not v_post.ok then
          raise exception 'affiliate cash-in commission failed: %', v_post.reason;
        end if;
        insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
        values (v_charge.bureau_id, v_charge.requested_by, 'affiliate.commission', 'affiliate_commissions',
          v_commission_id,
          jsonb_build_object('origin', 'cash_in', 'pix_charge_id', p_charge_id, 'pct', v_line.pct::text,
            'amount', v_amount::text, 'hold_days', v_hold));
        if v_hold = 0 then
          select * into v_post from public.affiliate_wallet_post_entry(
            v_line.beneficiary_id, 'commission_release', v_amount, 'release:' || v_commission_id::text,
            'commission:' || v_commission_id::text, v_line.beneficiary_id, 'cash_in');
          if not v_post.ok then
            raise exception 'affiliate cash-in release failed: %', v_post.reason;
          end if;
          update public.affiliate_commissions set status = 'released' where id = v_commission_id;
          insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
          values (v_charge.bureau_id, v_charge.requested_by, 'affiliate.commission_release', 'affiliate_commissions',
            v_commission_id, jsonb_build_object('origin', 'cash_in', 'amount', v_amount::text));
        end if;
      end if;
    else
      continue;
    end if;

    update public.charge_splits set status = 'done' where id = v_line.id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end
$$;

alter function record_cash_in_commission(uuid) owner to auth_profile_lookup;
revoke all on function record_cash_in_commission(uuid) from public, app_runtime;
grant execute on function record_cash_in_commission(uuid) to app_webhook;
