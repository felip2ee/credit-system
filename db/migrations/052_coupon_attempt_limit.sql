-- Limite de tentativas de código de cupom: no máximo 10 erros por hora por cliente (decisão do produto).
-- Achado F2 da revisão de segurança: sem limite, um cliente adivinha códigos pela prévia. A tabela só é lida e
-- gravada pelas funções do banco (dono auth_profile_lookup): app_runtime não tem grant nem política.
-- Só coupon_preview grava o erro. reserve_order só confere o limite: a recusa dela desfaz a transação inteira do
-- pedido (placeOrder lança e dá rollback), então um erro gravado ali se perderia. O limite vale igual nos dois.
-- Fora isso o corpo das funções é o de antes (coupon_preview: 049; reserve_order: 051). Dono, search_path e grants
-- não mudam (create or replace).

create table coupon_attempt_misses (
  profile_id uuid not null,
  bureau_id uuid not null,
  at timestamptz not null default now()
);
create index coupon_attempt_misses_profile_at_idx on coupon_attempt_misses (profile_id, at desc);

alter table coupon_attempt_misses enable row level security;
alter table coupon_attempt_misses force row level security;
grant select, insert, delete on coupon_attempt_misses to auth_profile_lookup;
create policy coupon_attempt_misses_gateway_select on coupon_attempt_misses for select to auth_profile_lookup using (true);
create policy coupon_attempt_misses_gateway_insert on coupon_attempt_misses for insert to auth_profile_lookup with check (true);
create policy coupon_attempt_misses_gateway_delete on coupon_attempt_misses for delete to auth_profile_lookup using (true);

-- Interna (sem grant): true quando o cliente já tem 10 erros na última hora. Apaga erros com mais de 1 dia.
create function coupon_attempts_blocked(p_profile uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.coupon_attempt_misses m
   where m.profile_id = p_profile and m.at < pg_catalog.now() - interval '1 day';
  return (select pg_catalog.count(*) from public.coupon_attempt_misses m
           where m.profile_id = p_profile and m.at >= pg_catalog.now() - interval '1 hour') >= 10;
end
$$;

alter function coupon_attempts_blocked(uuid) owner to auth_profile_lookup;
revoke all on function coupon_attempts_blocked(uuid) from public;

-- Prévia: volátil. No limite devolve zero linhas sem avaliar o código (mesmo resultado de um código inválido).
-- Cada caso que devolve zero linhas por causa do código grava um erro. Lista de produtos vazia não é erro.
create or replace function coupon_preview(p_code text, p_product_codes text[])
returns table (coupon_id uuid, kind text, value numeric, eligible_product_codes text[])
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_coupon public.coupons;
  v_uses integer;
  v_client_uses integer;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null
     or public.app_user_role() is distinct from 'client' or p_code is null then
    return;
  end if;
  if public.coupon_attempts_blocked(v_user) then
    return;
  end if;
  select * into v_coupon from public.coupons c
   where c.bureau_id = v_bureau and c.code = pg_catalog.upper(pg_catalog.btrim(p_code));
  if not found or not v_coupon.active
     or pg_catalog.now() < v_coupon.valid_from
     or (v_coupon.valid_until is not null and pg_catalog.now() >= v_coupon.valid_until) then
    insert into public.coupon_attempt_misses (profile_id, bureau_id) values (v_user, v_bureau);
    return;
  end if;
  select count(*), count(*) filter (where r.client_profile_id = v_user) into v_uses, v_client_uses
    from public.coupon_redemptions r
   where r.coupon_id = v_coupon.id and r.status in ('reserved', 'consumed');
  if (v_coupon.max_uses is not null and v_uses >= v_coupon.max_uses)
     or (v_coupon.max_uses_per_client is not null and v_client_uses >= v_coupon.max_uses_per_client) then
    insert into public.coupon_attempt_misses (profile_id, bureau_id) values (v_user, v_bureau);
    return;
  end if;
  return query
    select v_coupon.id, v_coupon.kind, v_coupon.value,
           coalesce((select pg_catalog.array_agg(distinct p.code order by p.code)
                       from public.products p
                      where p.code = any(coalesce(p_product_codes, array[]::text[]))
                        and (v_coupon.all_products
                             or exists (select 1 from public.coupon_products cp
                                         where cp.coupon_id = v_coupon.id and cp.product_id = p.id))),
                    array[]::text[]);
end
$$;

create or replace function reserve_order(
  p_order_ref uuid,
  p_mode text,
  p_client_profile_id uuid,
  p_price numeric,
  p_cost numeric,
  p_quote jsonb,
  p_coupon_code text default null
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
  v_code text;
  v_partners integer;
  v_item record;
  v_coupon public.coupons;
  v_coupon_code text;
  v_uses integer;
  v_client_uses integer;
  v_discount numeric := 0;
  v_paid numeric;
  v_falta numeric;
  v_wallet_avail numeric;
  v_wallet_part numeric := 0;
  v_payable_part numeric := 0;
  v_released numeric;
  v_redemption uuid;
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
  -- Com cupom o preço pago pode ser 0 e menor que o custo; sem cupom valem as regras de antes.
  if p_price is null or p_cost is null or p_price <> round(p_price, 2) or p_cost <> round(p_cost, 2)
     or p_price < 0 or (p_price = 0 and p_coupon_code is null)
     or p_cost < 0 or p_price > 99999999.99 or p_cost > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::text;
    return;
  end if;
  if p_price < p_cost and p_coupon_code is null then
    return query select false, 'price_below_cost'::text, null::text;
    return;
  end if;

  if not exists (
    select 1 from public.dossier_orders o
     where o.dossier_id = p_order_ref and o.bureau_id = v_bureau and o.mode = p_mode
       and (p_mode = 'counter' or o.client_profile_id = v_user)
  ) then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;

  -- Cupom: só no pedido online. O código vale sem espaços nas pontas e em maiúsculas.
  if p_coupon_code is not null then
    v_coupon_code := pg_catalog.upper(pg_catalog.btrim(p_coupon_code));
    if p_mode <> 'online' then
      return query select false, 'coupon_invalid'::text, null::text;
      return;
    end if;
    -- Repetição de uma reserva que já deu certo: devolve o estado sem validar de novo (a própria redenção
    -- contaria no limite).
    select * into v_existing from public.order_settlements where order_ref = p_order_ref;
    if found and v_existing.bureau_id = v_bureau and v_existing.coupon_id is not null
       and v_existing.client_profile_id is not distinct from p_client_profile_id
       and v_existing.price = p_price
       and exists (select 1 from public.coupons c
                    where c.id = v_existing.coupon_id and c.bureau_id = v_bureau and c.code = v_coupon_code) then
      return query select true, null::text, v_existing.status;
      return;
    end if;

    -- Limite de erros por hora: só confere (o erro é gravado na prévia; aqui o rollback do pedido o desfaria).
    if public.coupon_attempts_blocked(v_user) then
      return query select false, 'coupon_invalid'::text, null::text;
      return;
    end if;

    select * into v_coupon from public.coupons c where c.bureau_id = v_bureau and c.code = v_coupon_code;
    if not found then
      return query select false, 'coupon_invalid'::text, null::text;
      return;
    end if;
    -- Duas reservas do mesmo cupom se enfileiram aqui: a segunda conta os usos depois de a primeira gravar a dela.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coupon:' || v_coupon.id::text, 0));
    select * into v_coupon from public.coupons c where c.id = v_coupon.id;
    -- A repetição que esperou a trava: a primeira chamada já gravou a redenção. Repete a checagem de antes.
    select * into v_existing from public.order_settlements where order_ref = p_order_ref;
    if found and v_existing.bureau_id = v_bureau and v_existing.coupon_id is not null
       and v_existing.client_profile_id is not distinct from p_client_profile_id
       and v_existing.price = p_price and v_existing.coupon_id = v_coupon.id then
      return query select true, null::text, v_existing.status;
      return;
    end if;
    if not v_coupon.active then
      return query select false, 'coupon_invalid'::text, null::text;
      return;
    end if;
    if pg_catalog.now() < v_coupon.valid_from
       or (v_coupon.valid_until is not null and pg_catalog.now() >= v_coupon.valid_until) then
      return query select false, 'coupon_expired'::text, null::text;
      return;
    end if;
    select count(*), count(*) filter (where r.client_profile_id = p_client_profile_id)
      into v_uses, v_client_uses
      from public.coupon_redemptions r
     where r.coupon_id = v_coupon.id and r.status in ('reserved', 'consumed');
    if v_coupon.max_uses is not null and v_uses >= v_coupon.max_uses then
      return query select false, 'coupon_exhausted'::text, null::text;
      return;
    end if;
    if v_coupon.max_uses_per_client is not null and v_client_uses >= v_coupon.max_uses_per_client then
      return query select false, 'coupon_client_limit'::text, null::text;
      return;
    end if;
  end if;

  -- Preço e custo saem do pedido, não da cotação: produto do pedido, sócios = membros do Dossiê menos o Titular
  -- principal, valor base + valor por sócio no preço e no custo vigentes do Bureau. A cotação do chamador só
  -- é conferida pelo total; as linhas gravadas são as montadas aqui (o cliente não escolhe o que fica gravado).
  select o.product_code into v_code from public.dossier_orders o where o.dossier_id = p_order_ref;
  select greatest(count(*) - 1, 0) into v_partners from public.consultations c where c.dossier_id = p_order_ref;
  select p.id, i.sale_price, i.sale_price_per_partner, t.product_version_id, t.effective_cost,
         t.effective_cost_per_partner
    into v_item
    from public.products p
    join public.bureau_catalog_items i on i.bureau_id = v_bureau and i.product_id = p.id and i.active
    cross join lateral public.resolve_product_terms(v_bureau, p.id) t
   where p.code = v_code and p.active
     and t.effective_cost is not null and i.sale_price >= t.effective_cost
     and i.sale_price_per_partner >= t.effective_cost_per_partner;
  v_valid := found;
  v_fail := 'quote_mismatch';
  if v_valid then
    v_price := v_item.sale_price + v_item.sale_price_per_partner * v_partners;
    v_cost := v_item.effective_cost + v_item.effective_cost_per_partner * v_partners;
    v_lines := jsonb_build_array(jsonb_build_object(
      'productVersionId', v_item.product_version_id, 'code', v_code, 'part', 'base', 'quantity', 1,
      'unitPriceCents', (v_item.sale_price * 100)::bigint, 'unitCostCents', (v_item.effective_cost * 100)::bigint,
      'priceCents', (v_item.sale_price * 100)::bigint, 'costCents', (v_item.effective_cost * 100)::bigint));
    if v_partners > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'productVersionId', v_item.product_version_id, 'code', v_code, 'part', 'partner', 'quantity', v_partners,
        'unitPriceCents', (v_item.sale_price_per_partner * 100)::bigint,
        'unitCostCents', (v_item.effective_cost_per_partner * 100)::bigint,
        'priceCents', (v_item.sale_price_per_partner * v_partners * 100)::bigint,
        'costCents', (v_item.effective_cost_per_partner * v_partners * 100)::bigint));
    end if;
    -- Desconto: a base é o total das linhas que o cupom aceita (o pedido tem um produto só: todas ou nenhuma),
    -- arredondado uma vez. "coupon_products" só vale com all_products falso.
    v_paid := v_price;
    if v_coupon.id is not null then
      if not (v_coupon.all_products
              or exists (select 1 from public.coupon_products cp
                          where cp.coupon_id = v_coupon.id and cp.product_id = v_item.id)) then
        return query select false, 'coupon_product_not_allowed'::text, null::text;
        return;
      end if;
      v_discount := case v_coupon.kind
        when 'percent' then round(v_price * v_coupon.value / 100, 2)
        else least(v_coupon.value, v_price) end;
      v_paid := v_price - v_discount;
    end if;
    -- Cliente online manda um custo qualquer (não o conhece): só o preço, que é público, é conferido.
    if v_paid <> p_price then
      v_valid := false;
      v_fail := 'price_mismatch';
      v_discount := 0;
    elsif p_mode = 'counter' and v_cost <> p_cost then
      v_valid := false;
      v_fail := 'cost_mismatch';
    end if;
  else
    v_lines := '[]'::jsonb;
  end if;

  begin
    -- 1º: linha da liquidação. A unicidade de order_ref serializa duas reservas do mesmo pedido. Com a cotação
    -- inválida a linha é gravada com os valores do chamador e desfeita logo abaixo (RS001).
    insert into public.order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, quote,
                                          coupon_id, discount)
    values (p_order_ref, v_bureau, p_mode, p_client_profile_id, p_price,
      case when v_valid then v_cost else p_cost end,
      jsonb_build_object('lines', v_lines), v_coupon.id, v_discount)
    on conflict (order_ref) do nothing
    returning id into v_id;

    if v_id is null then
      select * into v_existing from public.order_settlements where order_ref = p_order_ref for update;
      if v_existing.bureau_id is distinct from v_bureau then
        return query select false, 'not_allowed'::text, null::text;
      elsif v_existing.mode = p_mode
         and v_existing.client_profile_id is not distinct from p_client_profile_id
         and v_existing.coupon_id is not distinct from v_coupon.id
         and v_existing.price = p_price and (p_mode = 'online' or v_existing.cost = p_cost) then
        return query select true, null::text, v_existing.status;
      else
        return query select false, 'already_exists'::text, null::text;
      end if;
      return;
    end if;

    if not v_valid then
      raise exception 'reserve_order rolled back' using errcode = 'RS001';
    end if;

    -- 2º: carteira do cliente (online, só se o preço pago é maior que 0) ou 3º: carteira do Bureau (balcão, só com custo > 0).
    select true as ok, null::text as reason into v_post;
    if p_mode = 'online' then
      if v_paid > 0 then
        select * into v_post from public.client_wallet_post_entry(
          p_client_profile_id, 'reserve', v_paid, 'order:reserve:' || p_order_ref::text,
          'order:' || p_order_ref::text, null, v_user);
      end if;
    elsif v_cost > 0 then
      select * into v_post from public.wallet_post_entry(
        v_bureau, 'reserve', v_cost, 'order:reserve:' || p_order_ref::text,
        'order:' || p_order_ref::text, null, v_user);
    end if;
    if not v_post.ok then
      v_fail := v_post.reason;
      raise exception 'reserve_order rolled back' using errcode = 'RS001';
    end if;

    -- 4º: o Bureau cobre a falta do cupom. Primeiro a carteira pré-paga (reserva), depois o valor a repassar
    -- liberado (coupon_cost). O lock é o de create_payout: um repasse e esta reserva não gastam o mesmo dinheiro, e o
    -- saldo liberado nunca fica abaixo de zero.
    if v_coupon.id is not null then
      v_falta := greatest(v_cost - v_paid, 0);
      if v_falta > 0 then
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payout:' || v_bureau::text, 0));
        select w.available into v_wallet_avail from public.wallets w where w.bureau_id = v_bureau for update;
        v_wallet_part := least(v_falta, coalesce(v_wallet_avail, 0));
        v_payable_part := v_falta - v_wallet_part;
        if v_payable_part > 0 then
          -- O mesmo conjunto de payable_buckets: o que nenhum repasse pegou; acréscimo só depois da retenção.
          select coalesce(sum(e.amount), 0) into v_released
            from public.bureau_payable_entries e
           where e.bureau_id = v_bureau
             and e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
             and (e.kind <> 'accrual'
                  or e.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => public.payable_retention_days()))
             and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
          if v_released < v_payable_part then
            v_fail := 'coupon_funds_insufficient';
            raise exception 'reserve_order rolled back' using errcode = 'RS001';
          end if;
        end if;
        if v_wallet_part > 0 then
          select * into v_post from public.wallet_post_entry(
            v_bureau, 'reserve', v_wallet_part, 'coupon:' || p_order_ref::text || ':wallet',
            'order:' || p_order_ref::text, 'cupom', v_user);
          if not v_post.ok then
            v_fail := 'coupon_funds_insufficient';
            raise exception 'reserve_order rolled back' using errcode = 'RS001';
          end if;
        end if;
        if v_payable_part > 0 then
          insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
          values (v_bureau, 'coupon_cost', -v_payable_part, p_order_ref);
        end if;
      end if;
      insert into public.coupon_redemptions
        (coupon_id, bureau_id, client_profile_id, order_ref, discount, funded_wallet, funded_payable)
      values (v_coupon.id, v_bureau, p_client_profile_id, p_order_ref, v_discount, v_wallet_part, v_payable_part)
      returning id into v_redemption;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_bureau, v_user, 'coupon.redeem', 'coupon_redemptions', v_redemption,
        jsonb_build_object('order_ref', p_order_ref, 'coupon_id', v_coupon.id, 'discount', v_discount::text,
          'funded_wallet', v_wallet_part::text, 'funded_payable', v_payable_part::text));
    end if;
  exception when sqlstate 'RS001' then
    return query select false, v_fail, null::text;
    return;
  end;

  return query select true, null::text, 'reserved'::text;
end
$$;
