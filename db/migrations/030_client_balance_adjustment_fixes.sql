-- Correções da revisão do ajuste de saldo do cliente (029 já aplicada: nada dela muda).
-- 1) Débito limitado ao que o Bureau creditou ao cliente (soma dos créditos menos a dos débitos de ajuste) e ao disponível:
--    exceeds_bureau_credit. A recarga paga pelo cliente nunca é removida.
-- 2) O perfil do cliente é lido "for share" antes das carteiras e relido (ativo, não anonimizado) sob a trava.
--    Ordem de travas: perfil do cliente -> carteira do cliente -> carteira do Bureau.
-- 3) O admin que ajusta e o Bureau precisam estar ativos.
-- 4) wallet_apply recusa chave de idempotência 'adjustment:%' (reservada aos lançamentos do ajuste). client_wallet_apply já
--    não existe (018).
-- 5) O motivo não pode levar documento (11 dígitos seguidos, CPF ou CNPJ formatado).
-- As políticas de auth_profile_lookup da 029 ficam: a role não tem BYPASSRLS (009), então a função precisa delas.

create or replace function adjust_client_balance(
  p_client_profile_id uuid, p_direction text, p_amount numeric, p_reason text, p_request_id uuid
)
returns table (ok boolean, reason text, adjustment_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_user uuid := public.app_user_id();
  v_bureau uuid := public.app_bureau_id();
  v_reason text := btrim(p_reason, E' \t\r\n');
  v_id uuid := p_request_id;
  v_existing public.client_balance_adjustments;
  v_client_available numeric;
  v_client_active boolean;
  v_client_anonymized timestamptz;
  v_bureau_credit numeric;
  v_bureau_available numeric;
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'bureau_admin'
     or public.app_support_session_id() is not null
     or v_user is null or v_bureau is null
     or not exists (select 1 from public.profiles p
                     where p.id = v_user and p.role = 'bureau_admin' and p.bureau_id = v_bureau and p.is_active)
     or not exists (select 1 from public.bureaus b where b.id = v_bureau and b.status = 'active') then
    return query select false, 'not_allowed'::text, null::uuid;
    return;
  end if;
  if p_request_id is null then
    return query select false, 'invalid_request'::text, null::uuid;
    return;
  end if;
  if p_direction is null or p_direction not in ('credit', 'debit') then
    return query select false, 'invalid_direction'::text, null::uuid;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid;
    return;
  end if;
  -- Documento no motivo: 11 dígitos seguidos ou CPF/CNPJ formatado. O motivo vai ao extrato do cliente e à auditoria.
  if v_reason is null or char_length(v_reason) not between 5 and 500
     or v_reason ~ '\d{11,}' or v_reason ~ '\d{3}\.\d{3}\.\d{3}-\d{2}' or v_reason ~ '\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}' then
    return query select false, 'invalid_reason'::text, null::uuid;
    return;
  end if;
  -- Ordem de travas: perfil do cliente (for share), carteira do cliente, carteira do Bureau. A anonimização trava o perfil
  -- "for no key update": uma das duas espera a outra, e o estado é relido sob a trava. Ela só lê as carteiras, sem travá-las,
  -- então não há ciclo.
  select p.is_active, p.anonymized_at into v_client_active, v_client_anonymized
    from public.profiles p
   where p.id = p_client_profile_id and p.role = 'client' and p.bureau_id = v_bureau
     for share;
  if not found or v_client_anonymized is not null or not v_client_active then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;

  -- Sob as travas das carteiras o saldo é conferido, então nenhum lançamento falha por saldo depois que outro já foi gravado.
  select available into v_client_available from public.client_wallets
   where client_profile_id = p_client_profile_id and bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  select available into v_bureau_available from public.wallets where bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  -- Repetição do mesmo pedido (clique duplo, reenvio): sob as travas, devolve o ajuste já feito sem lançar de novo,
  -- mesmo que o saldo tenha mudado desde então. O mesmo id com outro conteúdo ou de outro Bureau é conflito.
  select * into v_existing from public.client_balance_adjustments a where a.id = v_id;
  if found then
    if v_existing.bureau_id = v_bureau and v_existing.client_profile_id = p_client_profile_id
       and v_existing.direction = p_direction and v_existing.amount = p_amount
       and v_existing.reason = v_reason and v_existing.created_by = v_user then
      return query select true, null::text, v_id;
    else
      return query select false, 'request_conflict'::text, null::uuid;
    end if;
    return;
  end if;
  if p_direction = 'credit' and v_bureau_available < p_amount then
    return query select false, 'insufficient_bureau_funds'::text, null::uuid;
    return;
  end if;
  if p_direction = 'debit' then
    -- O Bureau remove só o que ele mesmo creditou (créditos menos débitos de ajuste) e nunca mais que o disponível:
    -- recarga paga pelo cliente nunca sai por aqui. A soma é estável porque a trava da carteira serializa os ajustes.
    select coalesce(sum(case a.direction when 'credit' then a.amount else -a.amount end), 0) into v_bureau_credit
      from public.client_balance_adjustments a
     where a.client_profile_id = p_client_profile_id and a.bureau_id = v_bureau;
    if p_amount > v_bureau_credit then
      return query select false, 'exceeds_bureau_credit'::text, null::uuid;
      return;
    end if;
    if p_amount > v_client_available then
      return query select false, 'insufficient_client_funds'::text, null::uuid;
      return;
    end if;
  end if;

  insert into public.client_balance_adjustments (id, bureau_id, client_profile_id, direction, amount, reason, created_by)
  values (v_id, v_bureau, p_client_profile_id, p_direction, p_amount, v_reason, v_user);

  -- O lançamento do cliente leva o próprio cliente como autor: o id da equipe não chega ao extrato dele.
  select * into v_post from public.client_wallet_post_entry(
    p_client_profile_id,
    case p_direction when 'credit' then 'adjustment_credit' else 'adjustment_debit' end,
    p_amount, 'adjustment:' || v_id::text || ':client', 'adjustment:' || v_id::text, v_reason, p_client_profile_id);
  if not v_post.ok then
    raise exception 'client wallet refused the adjustment: %', v_post.reason;
  end if;
  select * into v_post from public.wallet_post_entry(
    v_bureau,
    case p_direction when 'credit' then 'client_adjustment_out' else 'client_adjustment_in' end,
    p_amount, 'adjustment:' || v_id::text || ':bureau', 'adjustment:' || v_id::text, v_reason, v_user);
  if not v_post.ok then
    raise exception 'bureau wallet refused the adjustment: %', v_post.reason;
  end if;

  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user, 'client_wallet.adjust', 'client_balance_adjustments', v_id,
    jsonb_build_object('client_profile_id', p_client_profile_id, 'direction', p_direction,
                       'amount', p_amount::text, 'reason', v_reason));
  return query select true, null::text, v_id;
end
$$;

-- wallet_apply (015) sem as chaves 'adjustment:%'. Dono e grants não mudam.
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
  if p_idempotency_key like 'pix%' or p_idempotency_key like 'order:%' or p_idempotency_key like 'adjustment:%' then
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
