-- M6: pesquisa e entrega. A 001-021 já foram aplicadas e não mudam.
-- dossier_orders: um pedido por Dossiê; estado protegido por dossier_orders_guard.
-- open_order é a única porta de criação de Dossiê (cliente = online, equipe = balcão).
-- Perfil de sistema por Bureau: identidade do tick, sem account e sem sessão.
-- Toda escrita de abertura passa por função SECURITY DEFINER com dono auth_profile_lookup, sob as políticas *_gateway abaixo.
-- app_runtime executa só as funções públicas; create_bureau_system_profile e order_mask_document não têm grant.

-- Perfil de sistema (D15): só papel operator, um por Bureau.
alter table profiles add column if not exists is_system boolean not null default false;
alter table profiles drop constraint if exists profiles_system_operator;
alter table profiles add constraint profiles_system_operator check (not is_system or role = 'operator');
create unique index if not exists profiles_system_bureau_idx on profiles (bureau_id) where is_system;

-- Autorização por comprador (D10), contato do terceiro (D12) e prazo do pedido (D11).
alter table scr_authorizations
  add column if not exists client_profile_id uuid,
  add column if not exists phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column if not exists request_expires_at timestamptz;
alter table scr_authorizations drop constraint if exists scr_authorizations_buyer_fk;
alter table scr_authorizations
  add constraint scr_authorizations_buyer_fk foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id);
create index if not exists scr_authorizations_scope_idx on scr_authorizations (bureau_id, holder_id, client_profile_id, status);
create index if not exists scr_authorizations_pending_expiry_idx on scr_authorizations (request_expires_at) where status = 'pending';

alter table consultations add column if not exists scr_authorization_id uuid references scr_authorizations (id);

create table if not exists dossier_orders (
  dossier_id uuid primary key,
  bureau_id uuid not null references bureaus (id),
  mode text not null check (mode in ('online', 'counter')),
  client_profile_id uuid,
  product_code text not null check (product_code in ('dossie_pf', 'dossie_empresarial')),
  self_research boolean not null default false,
  subject_name text not null check (btrim(subject_name) <> '' and length(subject_name) <= 200),
  subject_document_masked text not null,
  state text not null check (state in ('awaiting_payment', 'awaiting_authorization', 'ready', 'executing',
    'completed', 'released', 'failed', 'cancelled')),
  state_reason text check (state_reason is null or state_reason in ('scr_refused', 'scr_expired', 'payment_timeout',
    'cancelled_by_staff', 'deps_no_data', 'deps_incompatible', 'deps_unavailable', 'reservation_clawed_back')),
  ai_status text not null default 'pending' check (ai_status in ('pending', 'done', 'failed')),
  ai_attempts integer not null default 0 check (ai_attempts between 0 and 10),
  attempts integer not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  released_at timestamptz,
  released_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason is null or (btrim(revoke_reason) <> '' and length(revoke_reason) <= 500)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dossier_orders_online_buyer check (mode <> 'online' or client_profile_id is not null),
  constraint dossier_orders_self_online check (not self_research or mode = 'online'),
  constraint dossier_orders_released check (state <> 'released' or released_at is not null),
  foreign key (bureau_id, dossier_id) references dossiers (bureau_id, id),
  foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id),
  foreign key (bureau_id, created_by) references profiles (bureau_id, id),
  foreign key (bureau_id, released_by) references profiles (bureau_id, id),
  foreign key (bureau_id, revoked_by) references profiles (bureau_id, id)
);
create index if not exists dossier_orders_due_idx on dossier_orders (bureau_id, state, next_attempt_at);
create index if not exists dossier_orders_client_idx on dossier_orders (client_profile_id, created_at desc) where client_profile_id is not null;

-- Só as transições da spec; colunas fora de v_mutable nunca mudam; nada se apaga.
create or replace function dossier_orders_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_mutable constant text[] := array['state', 'state_reason', 'ai_status', 'ai_attempts', 'attempts',
    'next_attempt_at', 'lease_until', 'released_at', 'released_by', 'revoked_at', 'revoked_by',
    'revoke_reason', 'updated_at'];
begin
  if tg_op <> 'UPDATE' then
    raise exception 'dossier_orders allows no delete' using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'dossier_orders immutable column changed' using errcode = 'check_violation';
  end if;
  if old.state = new.state or (old.state, new.state) in (
       ('awaiting_payment', 'awaiting_authorization'), ('awaiting_payment', 'ready'), ('awaiting_payment', 'cancelled'),
       ('awaiting_authorization', 'awaiting_payment'), ('awaiting_authorization', 'ready'),
       ('awaiting_authorization', 'cancelled'),
       ('ready', 'awaiting_payment'), ('ready', 'awaiting_authorization'), ('ready', 'executing'), ('ready', 'cancelled'),
       ('executing', 'ready'), ('executing', 'completed'), ('executing', 'failed'),
       ('completed', 'released'), ('released', 'completed')) then
    return new;
  end if;
  raise exception 'dossier_orders transition % -> % is not allowed', old.state, new.state
    using errcode = 'check_violation';
end
$$;
drop trigger if exists dossier_orders_guard on dossier_orders;
create trigger dossier_orders_guard before update or delete on dossier_orders
  for each row execute function dossier_orders_guard();
drop trigger if exists dossier_orders_no_truncate on dossier_orders;
create trigger dossier_orders_no_truncate before truncate on dossier_orders
  for each statement execute function dossier_orders_guard();

-- Máscara do documento no pedido (a mesma do M5): o cliente não lê o Titular de terceiro.
create or replace function order_mask_document(p_digits text) returns text
language sql immutable set search_path = pg_catalog, public as $$
  select case length(p_digits)
    when 11 then '***.' || substr(p_digits, 4, 3) || '.' || substr(p_digits, 7, 3) || '-**'
    when 14 then '**.' || substr(p_digits, 3, 3) || '.' || substr(p_digits, 6, 3) || '/' || substr(p_digits, 9, 4) || '-**'
  end
$$;

-- Estado do pedido a partir do dinheiro e do consentimento: pago (balcão: pagamentos não anulados >= preço) e todo membro
-- com autorização utilizável. Roda com os direitos de quem chama: a RLS decide quem atualiza. Membro sem autorização
-- ligada conta como não autorizado.
create or replace function refresh_order_state(p_dossier_id uuid)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_o public.dossier_orders;
  v_price numeric;
  v_paid numeric;
  v_paid_ok boolean := true;
  v_auth_ok boolean;
  v_next text;
begin
  select * into v_o from public.dossier_orders where dossier_id = p_dossier_id for update;
  if not found then return null; end if;
  if v_o.state not in ('awaiting_payment', 'awaiting_authorization', 'ready') then return v_o.state; end if;
  if v_o.mode = 'counter' then
    select s.price into v_price from public.order_settlements s where s.order_ref = p_dossier_id;
    select coalesce(sum(p.amount), 0) into v_paid from public.counter_payments p
     where p.dossier_id = p_dossier_id and p.voided_at is null;
    v_paid_ok := v_price is not null and v_paid >= v_price;
  end if;
  select bool_and(coalesce(s.status = 'authorized' and s.expires_at > now(), false)) into v_auth_ok
    from public.consultations c
    left join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.dossier_id = p_dossier_id;
  v_next := case when not v_paid_ok then 'awaiting_payment'
                 when coalesce(v_auth_ok, false) then 'ready'
                 else 'awaiting_authorization' end;
  if v_next <> v_o.state then
    update public.dossier_orders set state = v_next, updated_at = now() where dossier_id = p_dossier_id;
  end if;
  return v_next;
end
$$;

-- Perfil de sistema por Bureau (D15). O "user" não tem account: ninguém entra com ele.
create or replace function create_bureau_system_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := 'sistema+' || new.id || '@sistema.invalid';
begin
  insert into public."user" (id, name, email, email_verified) values (v_id::text, 'Sistema', v_email, true);
  insert into public.profiles (id, auth_user_id, full_name, email, role, bureau_id, is_system)
  values (v_id, v_id::text, 'Sistema', v_email, 'operator', new.id, true);
  return new;
end
$$;
drop trigger if exists bureaus_create_system_profile on bureaus;
create trigger bureaus_create_system_profile after insert on bureaus
  for each row execute function create_bureau_system_profile();

-- app_runtime tem INSERT e UPDATE em profiles (004): is_system e o perfil de sistema mudam só pelo dono.
create or replace function protect_system_profile()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user = 'app_runtime' then
    if tg_op = 'INSERT' and new.is_system then
      raise exception 'system profiles are created only with the bureau' using errcode = '42501';
    elsif tg_op = 'UPDATE' and (old.is_system or new.is_system) then
      raise exception 'system profiles do not change through the app' using errcode = '42501';
    elsif tg_op = 'DELETE' and old.is_system then
      raise exception 'system profiles do not change through the app' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
drop trigger if exists protect_system_profile on profiles;
create trigger protect_system_profile before insert or update or delete on profiles
  for each row execute function protect_system_profile();

-- Backfill: cada Bureau existente ganha o perfil de sistema.
do $$
declare
  v_b record;
  v_id uuid;
  v_email text;
begin
  for v_b in
    select b.id from bureaus b
     where not exists (select 1 from profiles p where p.bureau_id = b.id and p.is_system)
  loop
    v_id := gen_random_uuid();
    v_email := 'sistema+' || v_b.id || '@sistema.invalid';
    insert into "user" (id, name, email, email_verified) values (v_id::text, 'Sistema', v_email, true);
    insert into profiles (id, auth_user_id, full_name, email, role, bureau_id, is_system)
    values (v_id, v_id::text, 'Sistema', v_email, 'operator', v_b.id, true);
  end loop;
end
$$;

-- A sessão nunca resolve o perfil de sistema (004 + is_system).
create or replace function auth_profile_for_session(auth_id text)
returns table (
  user_id uuid,
  role text,
  bureau_id uuid,
  bureau_active boolean,
  is_active boolean,
  mfa_enabled boolean,
  support_session_id uuid,
  support_bureau_id uuid,
  support_expires_at timestamptz,
  must_change_password boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id, p.role::text, p.bureau_id, coalesce(b.status = 'active', false),
         p.is_active, p.mfa_enabled, s.id, s.bureau_id, s.expires_at,
         p.must_change_password
    from public.profiles p
    left join public.bureaus b on b.id = p.bureau_id
    left join lateral (
      select ss.id, ss.bureau_id, ss.expires_at
        from public.support_sessions ss
       where p.role = 'superadmin' and ss.superadmin_id = p.id
         and ss.ended_at is null and ss.started_at <= now() and ss.expires_at > now()
       order by ss.started_at desc
       limit 1) s on true
   where p.auth_user_id = auth_id
     and not p.is_system
$$;

-- D27: o pedido online pertence ao comprador (dossier_orders.client_profile_id), não ao Titular do Dossiê. O resto é a 018.
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
  v_code text;
  v_partners integer;
  v_item record;
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
    select 1 from public.dossier_orders o
     where o.dossier_id = p_order_ref and o.bureau_id = v_bureau and o.mode = p_mode
       and (p_mode = 'counter' or o.client_profile_id = v_user)
  ) then
    return query select false, 'not_found'::text, null::text;
    return;
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
    -- Cliente online manda um custo qualquer (não o conhece): só o preço, que é público, é conferido.
    if v_price <> p_price then
      v_valid := false;
      v_fail := 'price_mismatch';
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

-- D11: o pedido de autorização expira (request_expires_at). Confirmar um pedido vencido marca a linha 'expired' e
-- responde 'expired'; uma linha que já está 'expired' também. O resto é a 009.
create or replace function public.confirm_public_scr_authorization(
  p_token text,
  p_channel text,
  p_code text,
  p_decision text,
  p_ip text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_status text;
  v_auth_code text;
  v_bureau_id uuid;
  v_holder_id uuid;
  v_authorized boolean;
  v_request_expires_at timestamptz;
  v_buyer uuid;
  v_auth_email text;
  v_self_member boolean;
begin
  select s.id, s.status::text, s.auth_code, s.bureau_id, s.holder_id, s.request_expires_at, s.client_profile_id, s.email
    into v_id, v_status, v_auth_code, v_bureau_id, v_holder_id, v_request_expires_at, v_buyer, v_auth_email
    from public.scr_authorizations s
   where s.public_token = case when p_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_token::uuid end
     and s.channel = p_channel
     and p_channel = 'internal'
   for update;

  if not found then return 'not_found'; end if;
  if v_status in ('authorized', 'not_authorized') then return 'already'; end if;
  if v_status = 'expired' or (v_request_expires_at is not null and v_request_expires_at < now()) then
    if v_status <> 'expired' then
      update public.scr_authorizations
         set status = 'expired'::public.scr_status, auth_code = null, last_checked_at = now()
       where id = v_id;
      insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title)
      values (v_bureau_id, 'holder', v_holder_id, 'scr.expired', 'Pedido de autorização SCR expirado');
    end if;
    return 'expired';
  end if;
  if p_decision not in ('authorize', 'refuse') then return 'not_found'; end if;
  if p_decision = 'authorize'
     and (v_auth_code is null or upper(p_code) <> upper(v_auth_code)) then
    return 'invalid_code';
  end if;

  v_authorized := p_decision = 'authorize';
  update public.scr_authorizations
     set status = case when v_authorized then 'authorized'::public.scr_status else 'not_authorized'::public.scr_status end,
         authorized_at = case when v_authorized then now() else null end,
         consented_at = case when v_authorized then now() else null end,
         consent_ip = case when v_authorized then p_ip else null end,
         refused_at = case when v_authorized then null else now() end,
         expires_at = case when v_authorized then now() + interval '365 days' else null end,
         last_checked_at = now(),
         auth_code = null
   where id = v_id;

  -- A consulta sai de "Aguardando SCR" na hora, sem esperar o tick. A recusa não muda nada aqui.
  if v_authorized then
    update public.consultations set status = 'processing'
     where scr_authorization_id = v_id and status = 'pending_authorization';
  end if;

  -- self_member: o membro é o próprio comprador (o e-mail da autorização é o da conta dele). Sem documento na trilha.
  v_self_member := v_buyer is not null and exists (
    select 1 from public.profiles p where p.id = v_buyer and lower(p.email) = lower(v_auth_email));
  insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata)
  values (
    v_bureau_id,
    'holder',
    v_holder_id,
    case when v_authorized then 'scr.self_authorized' else 'scr.self_refused' end,
    case when v_authorized then 'Autorização SCR concedida pelo titular' else 'Autorização SCR recusada pelo titular' end,
    jsonb_build_object('self_member', v_self_member)
  );

  return case when v_authorized then 'authorized' else 'refused' end;
end
$$;

-- O perfil de sistema não conta como equipe (009 + not is_system).
create or replace function public.platform_bureau_metrics()
returns table (
  bureau_id uuid, name text, slug text, status text,
  staff_count bigint, holder_count bigint, dossier_count bigint,
  consultation_count bigint, consultations_30d bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.app_user_id() is null or public.app_user_role() is distinct from 'superadmin' then
    raise exception 'superadmin context required' using errcode = '42501';
  end if;
  return query
    select b.id, b.name, b.slug, b.status,
           (select count(*) from public.profiles p
             where p.bureau_id = b.id and p.role in ('bureau_admin', 'operator') and not p.is_system),
           (select count(*) from public.holders h where h.bureau_id = b.id),
           (select count(*) from public.dossiers d where d.bureau_id = b.id),
           (select count(*) from public.consultations c where c.bureau_id = b.id),
           (select count(*) from public.consultations c
             where c.bureau_id = b.id and c.created_at > now() - interval '30 days')
      from public.bureaus b
     order by b.name;
end
$$;

-- Credenciais nunca são definidas para o perfil de sistema: devolve false, como para qualquer alvo inexistente (009 + not is_system).
create or replace function public.admin_set_credentials(
  p_target_id uuid,
  p_bureau_id uuid,
  p_password_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := public.app_user_role();
begin
  if public.app_user_id() is null
     or not exists (
       select 1 from public.profiles c
        where c.id = public.app_user_id() and c.role::text = v_role and c.is_active)
     or not (
       (v_role = 'superadmin' and public.app_bureau_id() is null)
       or (v_role = 'bureau_admin' and p_bureau_id = public.app_bureau_id())) then
    raise exception 'admin context required' using errcode = '42501';
  end if;

  perform 1 from public.profiles p
   where p.id = p_target_id
     and p.bureau_id = p_bureau_id
     and p.role::text = case v_role when 'superadmin' then 'bureau_admin' else 'operator' end
     and not p.is_system
   for update;
  if not found then
    return false;
  end if;

  if p_password_hash is not null then
    update public.account set password = p_password_hash, updated_at = now()
     where user_id = p_target_id::text and provider_id = 'credential';
    if not found then
      insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
      values (gen_random_uuid()::text, 'local:credential', p_target_id::text, 'credential',
              p_target_id::text, p_password_hash, now());
    end if;
  elsif not exists (
    select 1 from public.account a
     where a.user_id = p_target_id::text and a.provider_id = 'credential') then
    return false;
  end if;

  update public.profiles set must_change_password = true where id = p_target_id;
  delete from public."session" where user_id = p_target_id::text;
  -- Better Auth guarda o link de redefinição como identifier 'reset-password:<token>', value = id do usuário.
  delete from public.verification
   where value = p_target_id::text and identifier like 'reset-password:%';
  return true;
end
$$;

-- Abertura do pedido (D2, D4, D8-D14, D25): Titulares, Dossiê, consultas, autorizações e pedido numa só transação.
-- Os passos de escrita ficam num bloco com subtransação: qualquer recusa depois da primeira escrita desfaz tudo e
-- devolve só o motivo (a transação do chamador segue e pode confirmar). Nunca atualiza um Titular existente (D12) e
-- nunca lê holders.email (D14). Documento, nome e contato não entram na auditoria.
create or replace function open_order(
  p_product_code text,
  p_self boolean,
  p_subject_type text,
  p_subject_name text,
  p_subject_document text,
  p_partners jsonb,
  p_contact_email text,
  p_contact_phone text,
  p_buyer_profile_id uuid
)
returns table (ok boolean, reason text, dossier_id uuid, state text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  -- Mesma forma de isValidEmail (src/lib/utils.ts): sem , ; ( ) < > " para o endereço não virar lista no nodemailer.
  c_email_re constant text := '^[^\s@,;()<>"]+@[^\s@,;()<>"]+\.[^\s@,;()<>"]+$';
  c_max_recent_requests constant integer := 3;
  -- Teto de pedidos online do mesmo cliente em 24 h: o teto por destinatário não segura quem abre, deixa o convite sair e cancela.
  c_max_online_orders_per_day constant integer := 5;
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_role text := public.app_user_role();
  v_mode text;
  v_self boolean := coalesce(p_self, false);
  v_partners jsonb := coalesce(nullif(p_partners, 'null'::jsonb), '[]'::jsonb);
  v_digits text := regexp_replace(coalesce(p_subject_document, ''), '\D', '', 'g');
  v_name text := btrim(coalesce(p_subject_name, ''));
  v_email text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_buyer uuid;
  v_buyer_p record;
  v_own record;
  v_main record;
  v_kind_bad boolean;
  v_type text;
  v_acct_type text;
  v_self_member boolean := false;
  v_buyer_as_company_contact boolean := false;
  v_deps_pf text;
  v_holder uuid;
  v_dossier uuid;
  v_members jsonb;
  v_member jsonb;
  v_partner jsonb;
  v_seen text[];
  v_i integer;
  v_h uuid;
  v_cid uuid;
  v_auth_id uuid;
  v_auth_email text;
  v_mdigits text;
  v_mname text;
  v_mtype text;
  v_memail text;
  v_recent integer;
  v_orders_today integer;
  v_pdigits text;
  v_pname text;
  v_pemail text;
  v_ppct numeric;
  v_prole text;
  v_state text;
  v_fail text;
begin
  -- 1) Contexto e papel. Superadmin em suporte lê como equipe, mas não abre pedido.
  if not public.app_context_present() or v_bureau is null or v_user is null then
    return query select false, 'not_allowed'::text, null::uuid, null::text;
    return;
  end if;
  if v_role = 'client' then
    v_mode := 'online';
  elsif v_role in ('bureau_admin', 'operator') and public.app_is_staff() then
    v_mode := 'counter';
  else
    return query select false, 'not_allowed'::text, null::uuid, null::text;
    return;
  end if;

  -- 2) Entrada. Sócios só no Dossiê Empresarial, no balcão e no online. Cliente: sem comprador. Equipe: sem pesquisa
  -- própria.
  if p_product_code is null or jsonb_typeof(v_partners) <> 'array'
     or (v_email is not null and (length(v_email) > 254 or v_email !~ c_email_re))
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$') then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;
  if v_mode = 'online' then
    if p_product_code not in ('dossie_pf', 'dossie_empresarial') or p_buyer_profile_id is not null then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_buyer := v_user;
  else
    if v_self then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_buyer := p_buyer_profile_id;
  end if;

  if jsonb_array_length(v_partners) > 0 and p_product_code <> 'dossie_empresarial' then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  if v_buyer is not null then
    select p.email, p.phone_e164, p.phone_verified_at into v_buyer_p
      from public.profiles p
     where p.id = v_buyer and p.role = 'client' and p.is_active and p.bureau_id = v_bureau;
    if not found then
      return query select false, 'buyer_not_found'::text, null::uuid, null::text;
      return;
    end if;
  end if;

  if v_mode = 'online' then
    -- Sem o lock, pedidos paralelos do mesmo cliente passam todos pela contagem (cada um só vê o que já foi confirmado).
    perform pg_advisory_xact_lock(hashtextextended('online_order_cap:' || v_user::text, 0));
    select count(*) into v_orders_today from public.dossier_orders o
     where o.client_profile_id = v_user and o.mode = 'online' and o.created_at > now() - interval '24 hours';
    if v_orders_today >= c_max_online_orders_per_day then
      return query select false, 'too_many_orders'::text, null::uuid, null::text;
      return;
    end if;
  end if;

  -- Pesquisa própria (online): o Titular mais antigo do cliente; o mesmo documento digitado como terceiro também vale.
  if v_mode = 'online' then
    if v_self then
      select h.id, h.type::text as type, h.document_digits, h.name into v_own
        from public.holders h
       where h.bureau_id = v_bureau and h.client_profile_id = v_user
       order by h.created_at, h.id limit 1;
      if not found then
        return query select false, 'self_holder_missing'::text, null::uuid, null::text;
        return;
      end if;
    elsif v_digits <> '' then
      select h.id, h.type::text as type, h.document_digits, h.name into v_own
        from public.holders h
       where h.bureau_id = v_bureau and h.client_profile_id = v_user and h.document_digits = v_digits
       order by h.created_at, h.id limit 1;
      v_self := found;
    end if;
  end if;
  -- Dossiê Pessoa Física no portal é do próprio cliente. Só a conta de Titular PJ pesquisa outra pessoa (o responsável).
  if v_mode = 'online' and p_product_code = 'dossie_pf' and not v_self then
    select h.type::text into v_acct_type
      from public.holders h
     where h.bureau_id = v_bureau and h.client_profile_id = v_user
     order by h.created_at, h.id limit 1;
    if v_acct_type is distinct from 'PJ' then
      return query select false, 'third_party_not_allowed'::text, null::uuid, null::text;
      return;
    end if;
  end if;
  if v_self then
    v_digits := v_own.document_digits;
    v_name := left(btrim(v_own.name), 200);
  elsif p_subject_type is null or p_subject_type not in ('PF', 'PJ') or length(v_digits) not in (11, 14)
        or v_name = '' or length(v_name) > 200 then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  -- 3) Produto à venda no Bureau: produto ativo, item ativo, preço e preço por sócio >= custo efetivo.
  select p.id, i.sale_price, t.product_version_id, v.deps_product into v_main
    from public.products p
    join public.bureau_catalog_items i on i.bureau_id = v_bureau and i.product_id = p.id and i.active
    cross join lateral public.resolve_product_terms(v_bureau, p.id) t
    join public.product_versions v on v.id = t.product_version_id
   where p.code = p_product_code and p.active
     and t.effective_cost is not null and i.sale_price >= t.effective_cost
     and i.sale_price_per_partner >= t.effective_cost_per_partner;
  if not found or v_main.deps_product is null then
    return query select false, 'product_not_for_sale'::text, null::uuid, null::text;
    return;
  end if;

  -- 4) Tipo: dossie_pf é de Titular PF (11 dígitos); dossie_empresarial, de Titular PJ (14 dígitos).
  v_type := case when p_product_code = 'dossie_pf' then 'PF' else 'PJ' end;
  -- v_own só existe na pesquisa própria (online): o plpgsql não garante curto-circuito, então o ramo é um if.
  if v_self then
    v_kind_bad := v_own.type <> v_type;
  else
    v_kind_bad := p_subject_type <> v_type or length(v_digits) <> case v_type when 'PF' then 11 else 14 end;
  end if;
  if v_kind_bad then
    return query select false, 'kind_mismatch'::text, null::uuid, null::text;
    return;
  end if;

  -- 6) Contato do Titular principal. Própria: e-mail da conta e celular só se confirmado. Terceiro (cliente): e-mail
  -- obrigatório. Em qualquer canal com comprador, o contato não pode ser o dele (D12). Equipe: o contato só é cobrado de
  -- quem não tem autorização utilizável (abaixo).
  if v_self then
    v_email := lower(v_buyer_p.email);
    v_phone := case when v_buyer_p.phone_verified_at is not null then v_buyer_p.phone_e164 end;
  else
    if v_mode = 'online' and v_email is null then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    -- v_buyer_p só existe com comprador: o plpgsql não garante curto-circuito, então o ramo é um if.
    if v_buyer is not null then
      -- Exceção (decisão do dono, risco aceito): no Dossiê Empresarial online, o e-mail do comprador também vale para o
      -- responsável da empresa quando o documento do Titular da conta dele está entre os sócios. O celular nunca vale.
      v_buyer_as_company_contact := v_mode = 'online' and p_product_code = 'dossie_empresarial'
        and v_email = lower(v_buyer_p.email)
        and exists (
          select 1 from jsonb_array_elements(v_partners) e
            join public.holders h on h.bureau_id = v_bureau and h.client_profile_id = v_user
                                 and h.document_digits = regexp_replace(coalesce(e ->> 'document', ''), '\D', '', 'g'));
      if (v_email = lower(v_buyer_p.email) and not v_buyer_as_company_contact)
         or (v_phone is not null and v_phone = v_buyer_p.phone_e164) then
        return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
        return;
      end if;
    end if;
  end if;

  -- Sócios (Dossiê Empresarial): validados antes de qualquer escrita. Sócio repetido conta uma vez.
  v_members := jsonb_build_array(jsonb_build_object('digits', v_digits, 'name', v_name, 'type', v_type,
    'email', v_email, 'phone', v_phone, 'deps', v_main.deps_product));
  if jsonb_array_length(v_partners) > 0 then
    -- O sócio usa o produto DEPS do Dossiê Pessoa Física (Smart PF 002), mesmo que ele não esteja à venda.
    select v.deps_product into v_deps_pf
      from public.products p
      cross join lateral public.resolve_product_terms(v_bureau, p.id) t
      join public.product_versions v on v.id = t.product_version_id
     where p.code = 'dossie_pf';
    if v_deps_pf is null then
      return query select false, 'product_not_for_sale'::text, null::uuid, null::text;
      return;
    end if;
    v_seen := array[v_digits];
    for v_partner in select e from jsonb_array_elements(v_partners) e loop
      v_pdigits := regexp_replace(coalesce(v_partner ->> 'document', ''), '\D', '', 'g');
      v_pname := btrim(coalesce(v_partner ->> 'name', ''));
      v_pemail := nullif(lower(btrim(coalesce(v_partner ->> 'email', ''))), '');
      v_prole := nullif(btrim(coalesce(v_partner ->> 'role', '')), '');
      v_ppct := null;
      -- D9: um consentimento por membro. O sócio precisa do próprio e-mail; o contato da empresa nunca vale por ele.
      if jsonb_typeof(v_partner) <> 'object' or length(v_pdigits) <> 11 or v_pdigits = v_digits
         or v_pname = '' or length(v_pname) > 200
         or v_pemail is null or length(v_pemail) > 254 or v_pemail !~ c_email_re
         or (v_prole is not null and length(v_prole) > 100)
         or (v_partner -> 'percentage' is not null and jsonb_typeof(v_partner -> 'percentage') not in ('number', 'null')) then
        return query select false, 'invalid_input'::text, null::uuid, null::text;
        return;
      end if;
      if jsonb_typeof(v_partner -> 'percentage') = 'number' then
        v_ppct := (v_partner ->> 'percentage')::numeric;
        if v_ppct < 0 or v_ppct > 100 then
          return query select false, 'invalid_input'::text, null::uuid, null::text;
          return;
        end if;
      end if;
      -- D12: no portal o sócio pode ter o e-mail do comprador só se o documento dele for o do Titular da conta do
      -- comprador. No balcão, nunca.
      if v_buyer is not null then
        if v_pemail = lower(v_buyer_p.email)
           and (v_mode = 'counter' or not exists (
                  select 1 from public.holders h
                   where h.bureau_id = v_bureau and h.client_profile_id = v_user and h.document_digits = v_pdigits)) then
          return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
          return;
        end if;
        if v_mode = 'online' and exists (
             select 1 from public.holders h
              where h.bureau_id = v_bureau and h.client_profile_id = v_user and h.document_digits = v_pdigits) then
          v_self_member := true;
        end if;
      end if;
      if v_pdigits = any (v_seen) then
        continue;
      end if;
      v_seen := v_seen || v_pdigits;
      v_members := v_members || jsonb_build_array(jsonb_build_object(
        'digits', v_pdigits, 'name', v_pname, 'type', 'PF',
        'email', v_pemail, 'phone', null,
        'deps', v_deps_pf,
        'percentage', v_ppct, 'role', v_prole));
    end loop;
  end if;

  begin
    -- 5) Titular principal: o próprio, o que já existe (sem tocar nele) ou um novo, criado só com nome e documento.
    if v_self then
      v_holder := v_own.id;
    else
      perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || v_digits, 0));
      select h.id into v_holder from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_digits;
      if v_holder is null then
        insert into public.holders (bureau_id, type, name, document, created_by)
        values (v_bureau, v_type::public.query_type, v_name, v_digits, v_user)
        on conflict (bureau_id, document_digits) do nothing
        returning id into v_holder;
        if v_holder is null then
          select h.id into v_holder from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_digits;
        end if;
      end if;
    end if;

    -- 7) Dossiê. O produto DEPS vem da versão vigente do produto principal (D25).
    insert into public.dossiers (bureau_id, kind, holder_id, product, status, created_by)
    values (v_bureau,
            case p_product_code when 'dossie_pf' then 'PF' else 'PJ_FULL' end::public.dossier_kind,
            v_holder, v_main.deps_product, 'pending', v_user)
    returning id into v_dossier;

    -- 8-10) Uma consulta e uma autorização por membro (Titular principal primeiro, depois os sócios).
    for v_i in 0 .. jsonb_array_length(v_members) - 1 loop
      v_member := v_members -> v_i;
      v_mdigits := v_member ->> 'digits';
      v_mname := v_member ->> 'name';
      v_mtype := v_member ->> 'type';
      v_memail := v_member ->> 'email';
      if v_i = 0 then
        v_h := v_holder;
      else
        perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || v_mdigits, 0));
        select h.id into v_h from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_mdigits;
        if v_h is null then
          insert into public.holders (bureau_id, type, name, document, created_by)
          values (v_bureau, v_mtype::public.query_type, v_mname, v_mdigits, v_user)
          on conflict (bureau_id, document_digits) do nothing
          returning id into v_h;
          if v_h is null then
            select h.id into v_h from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_mdigits;
          end if;
        end if;
        -- Só o balcão grava o vínculo: os sócios do pedido online vivem nas consultas do pedido, nunca na empresa.
        if v_mode = 'counter' then
          insert into public.holder_partnerships (bureau_id, company_id, partner_id, percentage, role, source, created_by)
          values (v_bureau, v_holder, v_h, (v_member ->> 'percentage')::numeric, v_member ->> 'role', 'operator', v_user)
          on conflict (company_id, partner_id) do nothing;
        end if;
      end if;

      -- Autorização utilizável (ou pedido ainda no prazo) do mesmo Bureau, Titular e comprador (D10).
      v_auth_id := null;
      v_auth_email := null;
      select s.id, s.email into v_auth_id, v_auth_email
        from public.scr_authorizations s
       where s.bureau_id = v_bureau and s.holder_id = v_h and s.client_profile_id is not distinct from v_buyer
         and s.channel = 'internal'
         and ((s.status = 'authorized' and s.expires_at > now())
              or (s.status = 'pending' and (s.request_expires_at is null or s.request_expires_at > now())))
       order by (s.status = 'authorized') desc, s.requested_at desc, s.id
       limit 1;
      if v_auth_id is null and v_memail is null then
        v_fail := 'invalid_input';
        raise exception 'open_order rolled back' using errcode = 'OR001';
      end if;

      insert into public.consultations
        (bureau_id, type, document, document_name, product, holder_id, dossier_id, created_by, status,
         requires_auth, scr_mode, scr_email)
      values (v_bureau, v_mtype::public.query_type, v_mdigits, v_mname, v_member ->> 'deps', v_h, v_dossier, v_user,
              'pending_authorization', true, 'internal', coalesce(v_memail, v_auth_email))
      returning id into v_cid;

      if v_auth_id is null then
        -- Teto de pedidos novos por destinatário (e-mail ou celular) em 24 h: ninguém usa o remetente para spam de um destino.
        -- A pesquisa própria vai para o e-mail da conta do comprador e não conta.
        if not (v_self and v_i = 0) then
          -- Mesmo motivo do teto por cliente: a contagem é por e-mail e por celular, então o lock é por e-mail e por celular.
          perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || lower(v_memail), 0));
          if v_member ->> 'phone' is not null then
            perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || (v_member ->> 'phone'), 0));
          end if;
          select count(*) into v_recent
            from public.scr_authorizations s
           where s.bureau_id = v_bureau and s.status = 'pending' and s.requested_at > now() - interval '24 hours'
             and (lower(s.email) = v_memail
                  or (v_member ->> 'phone' is not null and s.phone_e164 = v_member ->> 'phone'));
          if v_recent >= c_max_recent_requests then
            v_fail := 'too_many_requests';
            raise exception 'open_order rolled back' using errcode = 'OR001';
          end if;
        end if;
        -- O prazo do pedido conta da criação, mesmo que a emissão nunca aconteça; a emissão o renova.
        insert into public.scr_authorizations
          (bureau_id, document, type, name, email, phone_e164, holder_id, client_profile_id, consultation_id,
           requested_by, channel, request_expires_at)
        values (v_bureau, v_mdigits, v_mtype::public.query_type, v_mname, v_memail, v_member ->> 'phone', v_h, v_buyer,
                v_cid, v_user, 'internal', now() + interval '7 days')
        returning id into v_auth_id;
      end if;
      update public.consultations set scr_authorization_id = v_auth_id where id = v_cid;
    end loop;

    -- 11) Pedido. O balcão ainda não tem liquidação: o TypeScript atualiza o estado depois da reserva.
    insert into public.dossier_orders
      (dossier_id, bureau_id, mode, client_profile_id, product_code, self_research, subject_name,
       subject_document_masked, state, created_by)
    values (v_dossier, v_bureau, v_mode, v_buyer, p_product_code, v_self, v_name,
            public.order_mask_document(v_digits),
            case v_mode when 'online' then 'awaiting_authorization' else 'awaiting_payment' end, v_user);
    if v_mode = 'online' then
      perform public.refresh_order_state(v_dossier);
    end if;
    select o.state into v_state from public.dossier_orders o where o.dossier_id = v_dossier;

    -- 12) Trilha: sem documento, nome nem contato.
    insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata, created_by)
    values (v_bureau, 'holder', v_holder, 'order.opened', 'Pedido de pesquisa aberto',
            jsonb_build_object('dossier_id', v_dossier, 'mode', v_mode, 'product_code', p_product_code), v_user);
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (v_bureau, v_user, 'order.open', 'dossier_orders', v_dossier,
            jsonb_build_object('mode', v_mode, 'product_code', p_product_code,
                               'members', jsonb_array_length(v_members), 'self_member', v_self or v_self_member)
                            || case when v_buyer_as_company_contact then jsonb_build_object('buyer_as_company_contact', true)
                                    else '{}'::jsonb end);
  exception when sqlstate 'OR001' then
    return query select false, v_fail, null::uuid, null::text;
    return;
  end;

  -- 13)
  return query select true, null::text, v_dossier, v_state;
end
$$;

-- Bureaus com trabalho vencido para o tick (D16). Devolve só ids; o tick assume a identidade de sistema do Bureau.
create or replace function due_order_bureaus()
returns table (bureau_id uuid, system_profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.id, sp.id
    from public.bureaus b
    join public.profiles sp on sp.bureau_id = b.id and sp.is_system
   where b.status = 'active'
     and (
       exists (
         select 1 from public.dossier_orders o
          where o.bureau_id = b.id
            and ((o.state = 'awaiting_payment' and o.created_at < now() - interval '7 days')
              or o.state = 'awaiting_authorization'
              or (o.state = 'ready' and (o.next_attempt_at is null or o.next_attempt_at <= now()))
              or (o.state = 'executing' and (o.lease_until is null or o.lease_until < now()))
              or (o.state = 'completed' and (o.ai_status = 'pending'
                   or (o.mode = 'online' and o.ai_status <> 'pending' and o.revoked_at is null)))))
       or exists (
         select 1 from public.scr_authorizations s
          where s.bureau_id = b.id and s.status = 'pending' and s.request_expires_at < now())
     )
$$;

alter table dossier_orders owner to schema_owner;
alter function dossier_orders_guard() owner to schema_owner;
alter function order_mask_document(text) owner to schema_owner;
alter function refresh_order_state(uuid) owner to schema_owner;
alter function protect_system_profile() owner to schema_owner;
alter function create_bureau_system_profile() owner to auth_profile_lookup;
alter function open_order(text, boolean, text, text, text, jsonb, text, text, uuid) owner to auth_profile_lookup;
alter function due_order_bureaus() owner to auth_profile_lookup;

revoke all on function dossier_orders_guard() from public;
revoke all on function order_mask_document(text) from public;
revoke all on function refresh_order_state(uuid) from public;
revoke all on function protect_system_profile() from public;
revoke all on function create_bureau_system_profile() from public;
revoke all on function open_order(text, boolean, text, text, text, jsonb, text, text, uuid) from public;
revoke all on function due_order_bureaus() from public;
grant execute on function order_mask_document(text) to auth_profile_lookup;
grant execute on function refresh_order_state(uuid) to app_runtime, auth_profile_lookup;
grant execute on function open_order(text, boolean, text, text, text, jsonb, text, text, uuid) to app_runtime;
grant execute on function due_order_bureaus() to app_runtime;

alter table dossier_orders enable row level security;
alter table dossier_orders force row level security;

-- app_runtime: lê e muda só as colunas do ciclo do pedido. Sem INSERT (só open_order) e sem DELETE.
grant select, update (state, state_reason, ai_status, ai_attempts, attempts, next_attempt_at, lease_until,
  released_at, released_by, revoked_at, revoked_by, revoke_reason, updated_at) on dossier_orders to app_runtime;
grant select on dossier_orders to backup_reader;

drop policy if exists dossier_orders_staff_select on dossier_orders;
create policy dossier_orders_staff_select on dossier_orders for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
drop policy if exists dossier_orders_staff_update on dossier_orders;
create policy dossier_orders_staff_update on dossier_orders for update
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));
drop policy if exists dossier_orders_client_select on dossier_orders;
create policy dossier_orders_client_select on dossier_orders for select
  using (app_context_present() and app_user_role() = 'client'
         and bureau_id = app_bureau_id() and client_profile_id = app_user_id());

-- D23: o cliente lê a entrega só de pedido próprio em 'released'. Sem política de cliente em holders (fica a do M1),
-- scr_authorizations e bureau_payloads.
drop policy if exists dossiers_client_released on dossiers;
create policy dossiers_client_released on dossiers for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from dossier_orders o where o.dossier_id = dossiers.id
                      and o.client_profile_id = app_user_id() and o.state = 'released'));
drop policy if exists consultations_client_released on consultations;
create policy consultations_client_released on consultations for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from dossier_orders o where o.dossier_id = consultations.dossier_id
                      and o.client_profile_id = app_user_id() and o.state = 'released'));
drop policy if exists bureau_results_client_released on bureau_results;
create policy bureau_results_client_released on bureau_results for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = bureau_results.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));
drop policy if exists ai_reports_client_released on ai_reports;
create policy ai_reports_client_released on ai_reports for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = ai_reports.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select (is_system), insert (is_system) on public.profiles to auth_profile_lookup;
grant select (type, name, created_at) on public.holders to auth_profile_lookup;
grant select (company_id, partner_id), insert (bureau_id, company_id, partner_id, percentage, role, source, created_by)
  on public.holder_partnerships to auth_profile_lookup;
grant insert (bureau_id, kind, holder_id, product, status, created_by) on public.dossiers to auth_profile_lookup;
grant select (dossier_id, scr_authorization_id, status),
  insert (bureau_id, type, document, document_name, product, holder_id, dossier_id, created_by, status,
          requires_auth, scr_mode, scr_email),
  update (scr_authorization_id, status) on public.consultations to auth_profile_lookup;
grant select (email, phone_e164, client_profile_id, request_expires_at, requested_at),
  insert (bureau_id, document, type, name, email, phone_e164, holder_id, client_profile_id, consultation_id,
          requested_by, channel, request_expires_at) on public.scr_authorizations to auth_profile_lookup;
grant select (deps_product) on public.product_versions to auth_profile_lookup;
grant select, insert (dossier_id, bureau_id, mode, client_profile_id, product_code, self_research,
    subject_name, subject_document_masked, state, created_by),
  update (state, updated_at) on public.dossier_orders to auth_profile_lookup;
grant insert (metadata, created_by) on public.timeline_events to auth_profile_lookup;

drop policy if exists profiles_gateway_insert_system on profiles;
create policy profiles_gateway_insert_system on profiles for insert to auth_profile_lookup
  with check (is_system and role = 'operator' and bureau_id is not null);
drop policy if exists holders_gateway_order_insert on holders;
create policy holders_gateway_order_insert on holders for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and created_by = app_user_id() and client_profile_id is null);
drop policy if exists holder_partnerships_gateway_select on holder_partnerships;
create policy holder_partnerships_gateway_select on holder_partnerships for select to auth_profile_lookup
  using (true);
drop policy if exists holder_partnerships_gateway_order_insert on holder_partnerships;
create policy holder_partnerships_gateway_order_insert on holder_partnerships for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and created_by = app_user_id() and source = 'operator');
drop policy if exists dossiers_gateway_order_insert on dossiers;
create policy dossiers_gateway_order_insert on dossiers for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and created_by = app_user_id() and status = 'pending');
drop policy if exists consultations_gateway_order_insert on consultations;
create policy consultations_gateway_order_insert on consultations for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and created_by = app_user_id() and status = 'pending_authorization'
              and requires_auth and scr_mode = 'internal');
drop policy if exists consultations_gateway_order_update on consultations;
create policy consultations_gateway_order_update on consultations for update to auth_profile_lookup
  using (bureau_id = app_bureau_id() and status = 'pending_authorization')
  with check (bureau_id = app_bureau_id() and status = 'pending_authorization');
-- confirm_public_scr_authorization roda sem contexto de Bureau (rota pública): só tira a consulta de 'pending_authorization'
-- para 'processing', e só quando a autorização ligada a ela já está 'authorized'.
drop policy if exists consultations_gateway_scr_confirm on consultations;
create policy consultations_gateway_scr_confirm on consultations for update to auth_profile_lookup
  using (status = 'pending_authorization'
         and exists (select 1 from scr_authorizations s where s.id = consultations.scr_authorization_id and s.status = 'authorized'))
  with check (status = 'processing');
drop policy if exists scr_authorizations_gateway_order_insert on scr_authorizations;
create policy scr_authorizations_gateway_order_insert on scr_authorizations for insert to auth_profile_lookup
  with check (channel = 'internal' and bureau_id = app_bureau_id() and requested_by = app_user_id()
              and status = 'pending');
drop policy if exists dossier_orders_gateway_select on dossier_orders;
create policy dossier_orders_gateway_select on dossier_orders for select to auth_profile_lookup using (true);
drop policy if exists dossier_orders_gateway_insert on dossier_orders;
create policy dossier_orders_gateway_insert on dossier_orders for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and created_by = app_user_id());
drop policy if exists dossier_orders_gateway_update on dossier_orders;
create policy dossier_orders_gateway_update on dossier_orders for update to auth_profile_lookup
  using (true) with check (true);
drop policy if exists timeline_events_order_opened_gateway_insert on timeline_events;
create policy timeline_events_order_opened_gateway_insert on timeline_events for insert to auth_profile_lookup
  with check (
    entity_type = 'holder' and event_type = 'order.opened' and title = 'Pedido de pesquisa aberto'
    and bureau_id = app_bureau_id() and created_by = app_user_id()
    and exists (select 1 from holders h where h.id = timeline_events.entity_id and h.bureau_id = timeline_events.bureau_id)
  );
-- scr.expired nasce na confirmação pública (sem sessão): a mesma condição das duas linhas da 009.
drop policy if exists timeline_events_scr_expired_gateway_insert on timeline_events;
create policy timeline_events_scr_expired_gateway_insert on timeline_events for insert to auth_profile_lookup
  with check (
    entity_type = 'holder' and event_type = 'scr.expired' and title = 'Pedido de autorização SCR expirado'
    and exists (
      select 1 from scr_authorizations s
       where s.holder_id = timeline_events.entity_id
         and s.bureau_id = timeline_events.bureau_id
         and s.channel = 'internal')
  );
-- Auditoria de open_order: só esta ação, só junto do pedido do mesmo Bureau e autor criado na mesma transação.
drop policy if exists audit_logs_order_open_insert on audit_logs;
create policy audit_logs_order_open_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'order.open' and table_name = 'dossier_orders'
  and support_session_id is null
  and bureau_id = app_bureau_id() and user_id = app_user_id()
  and exists (
    select 1 from dossier_orders o
     where o.dossier_id = audit_logs.record_id and o.bureau_id = audit_logs.bureau_id
       and o.created_by = audit_logs.user_id and o.created_at = now())
);

-- Sementes de notificação (mesma forma da 020 e da 021). Os marcadores {{nome}} são trocados pelo renderizador.
insert into notification_templates (key, channel, version, params, wa_template_name, wa_language)
values ('scr_authorization', 'whatsapp', 1, array['clientName', 'authorizedName', 'code', 'url'],
        'scr_authorization', 'pt_BR')
on conflict (key, channel, version) do nothing;
insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
values (
  'research_released', 'email', 1, array['clientName', 'url'],
  $tpl$Sua pesquisa está disponível$tpl$,
  $tpl$<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#eef1f0;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f0;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:480px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <tr><td style="background:#0B5F59;text-align:center;padding:26px 24px 22px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.5px;">Eliane Moreira</div>
            <div style="font-size:11px;letter-spacing:3px;color:#C9A24B;margin-top:4px;">RAINHA DO CRÉDITO</div>
          </td></tr>
          <tr><td style="background:#0E8C84;color:#ffffff;text-align:center;padding:14px 24px;">
            <div style="font-size:17px;font-weight:700;">Sua pesquisa está disponível</div>
          </td></tr>
          <tr><td style="padding:26px 24px;text-align:center;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 22px;">Olá, {{clientName}}. O resultado da sua pesquisa já pode ser consultado.</p>
            <a href="{{url}}" style="display:inline-block;background:#C9A24B;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px;padding:14px 28px;border-radius:6px;">VER PESQUISA</a>
            <p style="margin:22px 0 0;font-size:12px;color:#6b7280;">Se o botão não funcionar, acesse: <br/><a href="{{url}}" style="color:#0B5F59;">{{url}}</a></p>
          </td></tr>
          <tr><td style="background:#0B5F59;padding:16px 24px;text-align:center;font-size:11px;color:#cfe7e4;">
            Eliane Moreira — Rainha do Crédito<br/>(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>$tpl$,
  $tpl$Olá, {{clientName}}.

O resultado da sua pesquisa já pode ser consultado.

Acesse em: {{url}}

Eliane Moreira — Rainha do Crédito
(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito$tpl$
)
on conflict (key, channel, version) do nothing;
insert into notification_templates (key, channel, version, params, wa_template_name, wa_language)
values ('research_released', 'whatsapp', 1, array['clientName', 'url'], 'research_released', 'pt_BR')
on conflict (key, channel, version) do nothing;
