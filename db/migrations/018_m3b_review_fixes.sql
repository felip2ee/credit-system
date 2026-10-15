-- M3b: correções da revisão do painel. A 003–017 já foram aplicadas e não mudam.
-- 1) order_settlements: app_runtime deixa de ler cost e quote (custo de atacado do Bureau). O cliente lê preço e
--    status; a equipe do Bureau e o superadmin leem custo e cotação por order_settlement_cost (como bureau_product_costs, 010).
-- 2) Estorno de PIX: o lançamento reversal tira do disponível e, no que faltar, do reservado (Bureau e cliente).
--    Só o que nenhum dos dois cobre vai para refund_shortfall. capture_order e release_order devolvem o motivo
--    (reservation_exceeded) quando a reserva foi retomada pelo estorno.
-- 3) Índices: três novos para as telas de cobrança e NFS-e; quatro sem uso saem.
-- 4) bureau_payable_entries: payout exige payout_id e accrual exige order_ref.
-- 5) client_wallet_apply (sem chamador) sai. Correção do comentário da 017 sobre o id do pagamento do Asaas.
-- 6) reserve_order exige que order_ref seja um Dossiê do Bureau (e, online, de um titular do cliente).
-- 7) reserve_order aceita balcão com custo 0: a carteira do Bureau não é tocada.
-- 8) reserve_order confere preço e custo no catálogo do Bureau (preço de venda, custo efetivo, adicional compatível)
--    em vez de confiar nos valores do chamador, e grava a cotação montada no banco.

-- 1) Custo fora do alcance do cliente. A política order_settlements_select_own mantém a linha do cliente; a coluna
--    só sai pela grant (a grant é por role do banco, não por papel do app).
revoke select on order_settlements from app_runtime;
grant select (id, order_ref, bureau_id, mode, client_profile_id, price, status, created_at, closed_at)
  on order_settlements to app_runtime;

-- Custo e cotação de um pedido: equipe do Bureau dono e superadmin (custo não é dado pessoal). Sem direito: sem linha.
create function order_settlement_cost(p_order_ref uuid)
returns table (cost numeric, quote jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present() then
    return;
  end if;
  return query
    select s.cost, s.quote
      from public.order_settlements s
     where s.order_ref = p_order_ref
       and (
         public.app_user_role() = 'superadmin'
         or (public.app_user_role() in ('bureau_admin', 'operator') and s.bureau_id = public.app_bureau_id())
       );
end
$$;

alter function order_settlement_cost(uuid) owner to auth_profile_lookup;
revoke all on function order_settlement_cost(uuid) from public;
grant execute on function order_settlement_cost(uuid) to app_runtime;

-- 2) Núcleo da carteira do Bureau (014) com o novo reversal: disponível primeiro, depois reservado.
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
      -- O dinheiro estornado sai do disponível; o que faltar sai da reserva, que deixa de ter lastro.
      v_available_after := greatest(v_available - p_amount, 0);
      v_reserved_after := v_reserved - greatest(p_amount - v_available, 0);
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

-- Núcleo da carteira do cliente (015) com o mesmo reversal. Não autoriza ninguém: só as funções de
-- liquidação e apply_asaas_payment a chamam.
create or replace function client_wallet_post_entry(
  p_client_profile_id uuid,
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
  v_bureau_id uuid;
  v_available numeric;
  v_reserved numeric;
  v_available_after numeric;
  v_reserved_after numeric;
  v_entry public.client_ledger_entries;
  v_id uuid;
begin
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'reversal') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or abs(p_amount) > 99999999.99 or p_amount <= 0 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, available, reserved into v_bureau_id, v_available, v_reserved
    from public.client_wallets where client_profile_id = p_client_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.client_ledger_entries
   where client_profile_id = p_client_profile_id and idempotency_key = p_idempotency_key;
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
    when 'reversal' then
      -- O dinheiro estornado sai do disponível; o que faltar sai da reserva, que deixa de ter lastro.
      v_available_after := greatest(v_available - p_amount, 0);
      v_reserved_after := v_reserved - greatest(p_amount - v_available, 0);
  end case;

  if v_available_after < 0 then
    return query select false, 'insufficient_balance'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if v_reserved_after < 0 then
    return query select false, 'reservation_exceeded'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.client_ledger_entries
    (bureau_id, client_profile_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by)
  values
    (v_bureau_id, p_client_profile_id, p_kind, p_amount, v_available_after, v_reserved_after, p_idempotency_key,
     p_reference, p_reason, p_created_by)
  returning id into v_id;
  update public.client_wallets set available = v_available_after, reserved = v_reserved_after
   where client_profile_id = p_client_profile_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

-- Webhook (015) com o estorno que também cobre a reserva. Dono, search_path, EXECUTE só para app_webhook e as
-- políticas estreitas de auditoria (014/015) ficam como estão: o estorno segue como um único lançamento reversal.
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
  v_reserved numeric;
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
      if v_charge.client_profile_id is null then
        select * into v_post from public.wallet_post_entry(
          v_charge.bureau_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
          'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
        v_audit_table := 'ledger_entries';
      else
        select * into v_post from public.client_wallet_post_entry(
          v_charge.client_profile_id, 'topup', v_charge.amount, 'pix:' || v_charge.id::text,
          'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
        v_audit_table := 'client_ledger_entries';
      end if;
      if not v_post.ok then
        raise exception 'wallet topup failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_charge.bureau_id, v_charge.requested_by, 'wallet.topup', v_audit_table, v_post.entry_id,
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
      -- Trava a carteira antes de ler o saldo: o estorno tira o disponível e, no que faltar, o reservado.
      if v_charge.client_profile_id is null then
        select available, reserved into strict v_available, v_reserved
          from public.wallets where bureau_id = v_charge.bureau_id for update;
      else
        select available, reserved into strict v_available, v_reserved
          from public.client_wallets where client_profile_id = v_charge.client_profile_id for update;
      end if;
      v_reversed := least(v_available + v_reserved, v_charge.amount);
      v_shortfall := v_charge.amount - v_reversed;
      update public.pix_charges set status = 'refunded', refund_shortfall = v_shortfall where id = v_charge.id;
      if v_reversed > 0 then
        if v_charge.client_profile_id is null then
          select * into v_post from public.wallet_post_entry(
            v_charge.bureau_id, 'reversal', v_reversed, 'pixrefund:' || v_charge.id::text,
            'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
          v_audit_table := 'ledger_entries';
        else
          select * into v_post from public.client_wallet_post_entry(
            v_charge.client_profile_id, 'reversal', v_reversed, 'pixrefund:' || v_charge.id::text,
            'pix_charge:' || v_charge.id::text, null, v_charge.requested_by);
          v_audit_table := 'client_ledger_entries';
        end if;
        if not v_post.ok then
          raise exception 'wallet reversal failed: %', v_post.reason;
        end if;
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

-- 6, 7 e 8) Reserva do pedido (015). O pedido é um Dossiê do Bureau da identidade; online, de um titular do cliente.
-- Balcão com custo 0 grava a liquidação sem reservar na carteira do Bureau (o lançamento exige valor > 0).
-- Preço e custo vêm do catálogo do Bureau, não do chamador. A cotação (p_quote) só diz quais produtos: de 1 a 2 linhas
-- com o campo code, um produto principal e, se houver, o adicional compatível. O banco soma o preço de venda e o custo
-- efetivo vigentes e grava a cotação montada por ele. Divergência devolve 'quote_mismatch', sempre o mesmo motivo.
-- O custo é dado oculto do cliente (item 1): no modo online o p_cost do chamador não é lido, então nenhuma resposta
-- muda com ele e não há como sondar o custo real por tentativa. Só o balcão (equipe, que já lê o custo) confere p_cost.
-- A repetição de um pedido já gravado compara só o que o chamador conhece (modo, cliente, preço e, no balcão, custo).
create or replace function reserve_order(
  p_order_ref uuid,
  p_mode text,
  p_client_profile_id uuid,
  p_price numeric,
  p_cost numeric,
  p_quote jsonb
)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_id uuid;
  v_existing public.order_settlements;
  v_post record;
  v_fail text;
  v_lines jsonb;
  v_price numeric;
  v_cost numeric;
  v_valid boolean;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or p_mode is null or p_mode not in ('online', 'counter') then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if p_mode = 'online' then
    if public.app_user_role() <> 'client' or p_client_profile_id is distinct from v_user then
      return query select false, 'not_allowed'::text, null::text;
      return;
    end if;
  elsif p_client_profile_id is not null or not public.app_is_staff() then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if p_price is null or p_cost is null or p_price <> round(p_price, 2) or p_cost <> round(p_cost, 2)
     or p_price <= 0 or p_cost < 0 or p_price > 99999999.99 or p_cost > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::text;
    return;
  end if;
  if p_price < p_cost then
    return query select false, 'price_below_cost'::text, null::text;
    return;
  end if;

  if not exists (
    select 1 from public.dossiers d
     where d.id = p_order_ref and d.bureau_id = v_bureau
       and (p_mode = 'counter' or exists (
         select 1 from public.holders h
          where h.id = d.holder_id and h.bureau_id = d.bureau_id and h.client_profile_id = v_user))
  ) then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;

  -- Catálogo do Bureau: as linhas pedidas, resolvidas no preço e no custo vigentes. Linha repetida, sem código, de
  -- produto fora de venda (item inativo, produto inativo, preço abaixo do custo) ou adicional sem o principal
  -- compatível deixa v_valid falso.
  with req as (
    select l ->> 'code' as code
      from jsonb_array_elements(
        case when jsonb_typeof(p_quote -> 'lines') = 'array' then p_quote -> 'lines' else '[]'::jsonb end) l
  ),
  cat as (
    select p.code, p.kind, p.addon_for, i.sale_price, t.product_version_id, t.effective_cost
      from (select distinct code from req where code is not null) r
      join public.products p on p.code = r.code and p.active
      join public.bureau_catalog_items i on i.bureau_id = v_bureau and i.product_id = p.id and i.active
      cross join lateral public.resolve_product_terms(v_bureau, p.id) t
     where t.effective_cost is not null and i.sale_price >= t.effective_cost
  )
  select
    (select count(*) from req) between 1 and 2
      and (select count(*) from req) = (select count(*) from cat)
      and (select count(*) from cat where kind = 'main') = 1
      and (select count(*) from cat) = 1 + (select count(*) from cat where kind = 'addon'
          and addon_for @> array[(select min(code) from cat where kind = 'main')]),
    coalesce(sum(sale_price), 0),
    coalesce(sum(effective_cost), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'productVersionId', product_version_id, 'code', code,
      'costCents', (effective_cost * 100)::bigint, 'priceCents', (sale_price * 100)::bigint
    ) order by (kind = 'addon'), code), '[]'::jsonb)
    into v_valid, v_price, v_cost, v_lines
    from cat;
  v_valid := coalesce(v_valid, false) and v_price = p_price and (p_mode = 'online' or v_cost = p_cost);

  begin
    -- 1º: linha da liquidação. A unicidade de order_ref serializa duas reservas do mesmo pedido. Com a cotação
    -- inválida a linha é gravada com os valores do chamador e desfeita logo abaixo (RS001).
    insert into public.order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, quote)
    values (p_order_ref, v_bureau, p_mode, p_client_profile_id, p_price,
      case when v_valid then v_cost else p_cost end,
      jsonb_build_object('lines', v_lines))
    on conflict (order_ref) do nothing
    returning id into v_id;

    if v_id is null then
      select * into v_existing from public.order_settlements where order_ref = p_order_ref for update;
      if v_existing.bureau_id is distinct from v_bureau then
        return query select false, 'not_allowed'::text, null::text;
      elsif v_existing.mode = p_mode
         and v_existing.client_profile_id is not distinct from p_client_profile_id
         and v_existing.price = p_price and (p_mode = 'online' or v_existing.cost = p_cost) then
        return query select true, null::text, v_existing.status;
      else
        return query select false, 'already_exists'::text, null::text;
      end if;
      return;
    end if;

    if not v_valid then
      v_fail := 'quote_mismatch';
      raise exception 'reserve_order rolled back' using errcode = 'RS001';
    end if;

    -- 2º: carteira do cliente (online) ou 3º: carteira do Bureau (balcão, só com custo > 0).
    select true as ok, null::text as reason into v_post;
    if p_mode = 'online' then
      select * into v_post from public.client_wallet_post_entry(
        p_client_profile_id, 'reserve', v_price, 'order:reserve:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    elsif v_cost > 0 then
      select * into v_post from public.wallet_post_entry(
        v_bureau, 'reserve', v_cost, 'order:reserve:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    end if;
    if not v_post.ok then
      v_fail := v_post.reason;
      raise exception 'reserve_order rolled back' using errcode = 'RS001';
    end if;
  exception when sqlstate 'RS001' then
    return query select false, v_fail, null::text;
    return;
  end;

  return query select true, null::text, 'reserved'::text;
end
$$;

-- Captura (015). Falha da carteira (reservation_exceeded: o estorno retomou a reserva) volta como motivo, sem
-- crédito e sem acréscimo; nada foi gravado antes dela. Balcão com custo 0 não toca a carteira.
create or replace function capture_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'released' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  if v_s.mode = 'online' then
    select * into v_post from public.client_wallet_post_entry(
      v_s.client_profile_id, 'capture', v_s.price, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      return query select false, v_post.reason, v_s.status;
      return;
    end if;
    if v_s.price > v_s.cost then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
      values (v_s.bureau_id, 'accrual', v_s.price - v_s.cost, v_s.order_ref);
    end if;
  elsif v_s.cost > 0 then
    select * into v_post from public.wallet_post_entry(
      v_s.bureau_id, 'capture', v_s.cost, 'order:capture:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
    if not v_post.ok then
      return query select false, v_post.reason, v_s.status;
      return;
    end if;
  end if;

  update public.order_settlements set status = 'captured', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'captured'::text;
end
$$;

-- Liberação (015). Mesma regra de falha e de custo 0 da captura.
create or replace function release_order(p_order_ref uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_s public.order_settlements;
  v_post record;
begin
  if not public.app_context_present() or v_bureau is null or p_order_ref is null
     or not (public.app_user_role() = 'client' or public.app_is_staff()) then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_s from public.order_settlements where order_ref = p_order_ref for update;
  if not found or v_s.bureau_id <> v_bureau then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if public.app_user_role() = 'client' and v_s.client_profile_id is distinct from v_user then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if v_s.status = 'released' then
    return query select true, null::text, v_s.status;
    return;
  end if;
  if v_s.status = 'captured' then
    return query select false, 'invalid_state'::text, v_s.status;
    return;
  end if;

  select true as ok, null::text as reason into v_post;
  if v_s.mode = 'online' then
    select * into v_post from public.client_wallet_post_entry(
      v_s.client_profile_id, 'release', v_s.price, 'order:release:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
  elsif v_s.cost > 0 then
    select * into v_post from public.wallet_post_entry(
      v_s.bureau_id, 'release', v_s.cost, 'order:release:' || p_order_ref::text,
      'order:' || p_order_ref::text, null, v_user);
  end if;
  if not v_post.ok then
    return query select false, v_post.reason, v_s.status;
    return;
  end if;

  update public.order_settlements set status = 'released', closed_at = now() where id = v_s.id;
  return query select true, null::text, 'released'::text;
end
$$;

-- 6) reserve_order lê dossiers e holders como dono: só as colunas que a checagem usa.
grant select (holder_id) on public.dossiers to auth_profile_lookup;
grant select (client_profile_id) on public.holders to auth_profile_lookup;

-- 3) Índices. Os três primeiros servem às telas de cobrança do Bureau, de estorno não recuperado e de NFS-e com
-- falha. Os quatro que saem não têm consulta: order_settlements e client_ledger_entries são lidos por order_ref e
-- por client_profile_id; payout_items por payout_id (chave primária).
create index pix_charges_bureau_own_created_idx on pix_charges(bureau_id, created_at desc)
  where client_profile_id is null;
create index pix_charges_shortfall_idx on pix_charges(bureau_id, created_at desc)
  where refund_shortfall > 0;
create index pix_charges_nfse_failed_idx on pix_charges(nfse_updated_at desc nulls last, id)
  where nfse_status = 'failed';

drop index client_ledger_entries_bureau_idx;
drop index order_settlements_bureau_created_idx;
drop index order_settlements_client_idx;
drop index payout_items_bureau_idx;

-- 4) Integridade do valor a repassar: o lançamento de repasse aponta para o repasse e o acréscimo, para o pedido.
alter table bureau_payable_entries add constraint bureau_payable_entries_payout_required
  check ((kind = 'payout') = (payout_id is not null));
alter table bureau_payable_entries add constraint bureau_payable_entries_accrual_order
  check (kind <> 'accrual' or order_ref is not null);

-- 5) Sem chamador: a sessão do cliente reserva, captura e libera por reserve_order, capture_order e release_order.
drop function client_wallet_apply(uuid, text, numeric, text, text, text);

-- Correção da 017: o comentário "O id do pagamento do Asaas não sai para nenhuma outra role" está errado.
-- app_runtime tem SELECT em pix_charges (012), então a equipe do Bureau e o cliente leem asaas_payment_id das
-- próprias cobranças, e o superadmin sem suporte o recebe por nfse_charge_payment. O id não é segredo:
-- o que a 017 garante é que nfse_charge_by_payment (id do pagamento -> id da cobrança) é só do app_webhook.
