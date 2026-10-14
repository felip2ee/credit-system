-- M3a: estorno de PIX, role própria do webhook e endurecimentos da revisão. A 012 e a 013 já foram aplicadas e não mudam.
-- 1) PAYMENT_REFUNDED de cobrança paga: status 'refunded' e lançamento 'reversal' que tira do saldo
--    disponível no máximo o valor da cobrança (nunca do reservado, nunca abaixo de zero). O que não deu
--    para recuperar fica em pix_charges.refund_shortfall, para o superadmin tratar.
-- 2) app_webhook: única role com EXECUTE em apply_asaas_payment. Sem privilégio em nenhuma tabela.
--    A senha não vem desta migração: docker/postgres/init/001-users.sh (volume novo) ou ALTER ROLE (volume existente).
-- 3) asaas_webhook_events.payload fica nulo para evento de cobrança desconhecida (sem corpo guardado).
-- 4) Índice parcial das cobranças pendentes, para countPendingPixCharges.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_webhook') then
    create role app_webhook login;
  end if;
end
$$;
alter role app_webhook NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
grant usage on schema public to app_webhook;
do $$
begin
  execute format('grant connect on database %I to app_webhook', current_database());
end
$$;

alter table ledger_entries drop constraint ledger_entries_kind_check;
alter table ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('topup', 'reserve', 'capture', 'release', 'adjustment', 'reversal'));

alter table pix_charges drop constraint pix_charges_status_check;
alter table pix_charges add constraint pix_charges_status_check
  check (status in ('pending', 'paid', 'expired', 'cancelled', 'refunded'));
alter table pix_charges add column refund_shortfall numeric(15,2) not null default 0
  check (refund_shortfall >= 0);
grant update (refund_shortfall) on pix_charges to auth_profile_lookup;

alter table asaas_webhook_events drop constraint asaas_webhook_events_result_check;
alter table asaas_webhook_events add constraint asaas_webhook_events_result_check
  check (result in ('received', 'credited', 'refunded', 'duplicate', 'ignored', 'unknown_charge'));
alter table asaas_webhook_events alter column payload drop not null;

create index pix_charges_pending_idx on pix_charges(bureau_id, expires_at) where status = 'pending';

-- O superadmin sem suporte lê só as cobranças com estorno não recuperado (tela de pendências).
create policy pix_charges_select_shortfall on pix_charges for select using (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
  and refund_shortfall > 0
);

create or replace function wallet_post_entry(
  p_bureau_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text,
  p_created_by uuid
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_available numeric;
  v_reserved numeric;
  v_available_after numeric;
  v_reserved_after numeric;
  v_entry public.ledger_entries;
  v_id uuid;
begin
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'adjustment', 'reversal') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or abs(p_amount) > 99999999.99
     or (p_kind = 'adjustment' and p_amount = 0) or (p_kind <> 'adjustment' and p_amount <= 0) then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select available, reserved into v_available, v_reserved
    from public.wallets where bureau_id = p_bureau_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.ledger_entries
   where bureau_id = p_bureau_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.available_after, v_entry.reserved_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_available_after := v_available;
  v_reserved_after := v_reserved;
  case p_kind
    when 'topup' then
      v_available_after := v_available + p_amount;
    when 'reserve' then
      v_available_after := v_available - p_amount;
      v_reserved_after := v_reserved + p_amount;
    when 'capture' then
      v_reserved_after := v_reserved - p_amount;
    when 'release' then
      v_reserved_after := v_reserved - p_amount;
      v_available_after := v_available + p_amount;
    when 'adjustment' then
      v_available_after := v_available + p_amount;
    when 'reversal' then
      v_available_after := v_available - p_amount;
  end case;

  if v_available_after < 0 then
    return query select false, 'insufficient_balance'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if v_reserved_after < 0 then
    return query select false, 'reservation_exceeded'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.ledger_entries
    (bureau_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by)
  values
    (p_bureau_id, p_kind, p_amount, v_available_after, v_reserved_after, p_idempotency_key, p_reference, p_reason, p_created_by)
  returning id into v_id;
  update public.wallets set available = v_available_after, reserved = v_reserved_after
   where bureau_id = p_bureau_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

-- Os prefixos "pix:" (crédito) e "pixrefund:" (estorno) são do webhook e não podem colidir com a sessão.
create or replace function wallet_apply(
  p_bureau_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present()
     or p_kind not in ('reserve', 'capture', 'release', 'adjustment') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key like 'pix:%' or p_idempotency_key like 'pixrefund:%' then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_kind = 'adjustment' then
    if public.app_user_role() <> 'superadmin' then
      return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
      return;
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      return query select false, 'reason_required'::text, null::uuid, null::numeric, null::numeric, false;
      return;
    end if;
  elsif public.app_bureau_id() is distinct from p_bureau_id then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  return query select * from public.wallet_post_entry(
    p_bureau_id, p_kind, p_amount, p_idempotency_key, p_reference, p_reason, public.app_user_id());
end
$$;

-- Os nomes de evento daqui espelham as constantes de src/lib/asaas/client.ts (um teste confere).
-- Estorno: só de cobrança 'paid'. Estorno de outro estado, e PAYMENT_PARTIALLY_REFUNDED, ficam 'ignored'.
create or replace function apply_asaas_payment(
  p_event_id text,
  p_event_type text,
  p_asaas_payment_id text,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_post record;
  v_event_row uuid;
  v_result text;
  v_available numeric;
  v_reversed numeric;
  v_shortfall numeric;
  v_audit_table text;
  v_audit_record uuid;
begin
  select * into v_charge from public.pix_charges where asaas_payment_id = p_asaas_payment_id;

  -- Cobrança desconhecida: guarda só o registro do evento, sem o corpo (evita inchar a tabela).
  insert into public.asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
  values (v_charge.bureau_id, p_event_id, p_event_type, p_asaas_payment_id,
    case when v_charge.id is null then null else coalesce(p_payload, '{}'::jsonb) end, 'received')
  on conflict (event_id) do nothing
  returning id into v_event_row;
  if v_event_row is null then
    return 'duplicate';
  end if;

  if v_charge.id is null then
    v_result := 'unknown_charge';
  elsif p_event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status in ('paid', 'refunded') then
      v_result := 'duplicate';
    elsif v_charge.status = 'cancelled' then
      v_result := 'ignored';
    else
      update public.pix_charges set status = 'paid' where id = v_charge.id;
      select * into v_post from public.wallet_post_entry(
        v_charge.bureau_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
        'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
      if not v_post.ok then
        raise exception 'wallet topup failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', 'ledger_entries', v_post.entry_id,
        jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id, 'amount', v_charge.amount::text));
      v_result := 'credited';
    end if;
  elsif p_event_type = 'PAYMENT_REFUNDED' then
    select * into v_charge from public.pix_charges where id = v_charge.id for update;
    if v_charge.status = 'refunded' then
      v_result := 'duplicate';
    elsif v_charge.status <> 'paid' then
      v_result := 'ignored';
    else
      -- Trava a carteira antes de ler o saldo: o estorno tira só o que está disponível agora.
      select available into strict v_available
        from public.wallets where bureau_id = v_charge.bureau_id for update;
      v_reversed := least(v_available, v_charge.amount);
      v_shortfall := v_charge.amount - v_reversed;
      update public.pix_charges set status = 'refunded', refund_shortfall = v_shortfall where id = v_charge.id;
      if v_reversed > 0 then
        select * into v_post from public.wallet_post_entry(
          v_charge.bureau_id, 'reversal', v_reversed, 'pixrefund:' || v_charge.id::text,
          'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
        if not v_post.ok then
          raise exception 'wallet reversal failed: %', v_post.reason;
        end if;
        v_audit_table := 'ledger_entries';
        v_audit_record := v_post.entry_id;
      else
        -- Sem saldo não há lançamento (valor > 0): a auditoria aponta para a cobrança.
        v_audit_table := 'pix_charges';
        v_audit_record := v_charge.id;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.reversal', v_audit_table, v_audit_record,
        jsonb_build_object('source', 'asaas_webhook', 'pix_charge_id', v_charge.id,
          'amount', v_reversed::text, 'shortfall', v_shortfall::text));
      v_result := 'refunded';
    end if;
  else
    v_result := 'ignored';
  end if;

  update public.asaas_webhook_events set result = v_result where id = v_event_row;
  return v_result;
end
$$;

-- Auditoria do estorno: mesma ideia da audit_logs_topup_insert. Só o dono das funções, só wallet.reversal,
-- e só junto de um lançamento reversal do mesmo Bureau e autor criado na mesma transação. Sem saldo para
-- estornar não há lançamento: então vale a cobrança do mesmo Bureau e autor, já marcada como refunded.
create policy audit_logs_reversal_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'wallet.reversal'
  and support_session_id is null
  and bureau_id is not null
  and (
    (
      table_name = 'ledger_entries'
      and exists (
        select 1 from ledger_entries e
         where e.id = audit_logs.record_id
           and e.kind = 'reversal'
           and e.bureau_id = audit_logs.bureau_id
           and e.created_by = audit_logs.user_id
           and e.created_at = now()
      )
    )
    or (
      table_name = 'pix_charges'
      and exists (
        select 1 from pix_charges c
         where c.id = audit_logs.record_id
           and c.status = 'refunded'
           and c.bureau_id = audit_logs.bureau_id
           and c.requested_by = audit_logs.user_id
      )
    )
  )
);

-- Só app_webhook executa o crédito/estorno do webhook; app_runtime não, para que uma injeção de SQL na
-- aplicação não consiga fabricar cobrança e creditar.
revoke all on function apply_asaas_payment(text, text, text, jsonb) from public, app_runtime;
grant execute on function apply_asaas_payment(text, text, text, jsonb) to app_webhook;
