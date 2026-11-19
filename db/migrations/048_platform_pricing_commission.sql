-- Comissão dos Bureaus (spec 2026-11-19-comissao-bureaus-design.md, seções 2, 3.1, 3.2 e 4). A 001-047 já foram aplicadas e não mudam.
-- Só o superadmin define o preço de venda do produto, a % do Bureau, a % de afiliados do Bureau e o bloqueio de produto
-- por Bureau. O Bureau recebe uma % do preço bruto de cada venda; a plataforma fica com o resto (order_settlements.cost
-- passa a ser a parte da plataforma nos pedidos novos). A comissão do afiliado também é % do preço bruto e sai da parte
-- da plataforma.
-- 1) product_versions: sale_price e sale_price_per_partner (nulo = não à venda) e current_product_price.
-- 2) settings.bureau_commission_pct (global), bureau_commission_rates (override), bureau_product_blocks (bloqueio) e as
--    funções resolve_bureau_commission_pct e product_blocked_for_bureau.
-- 3) order_settlements: commission_pct e bureau_commission (nulos em pedido antigo).
-- 4) Legado só leitura: bureau_catalog_items, bureau_product_costs e affiliate_rates perdem as políticas de escrita.
--    bureau_affiliate_settings passa a ser escrita só pelo superadmin (sem suporte).
-- 5) audit_logs_insert: acrescenta commission.bureau_set, catalog.block_set e affiliate.rate ao ramo do superadmin.
-- 6) public_bureau_catalog, open_order, reserve_order e capture_order redefinidas (cópia da última versão; só mudam a
--    consulta de catálogo, o cálculo de preço/comissão e o ramo novo da captura).
-- Nenhum preço, % ou bloqueio é gravado aqui: sem preço o produto não está à venda; sem % global (e sem override)
-- reserve_order recusa com commission_not_configured.

-- 1) Preço de venda (só superadmin, por nova versão: a tabela é imutável).
alter table product_versions
  add column sale_price numeric(15,2) check (sale_price > 0 and sale_price <= 99999999.99),
  add column sale_price_per_partner numeric(15,2) not null default 0
    check (sale_price_per_partner >= 0 and sale_price_per_partner <= 99999999.99);

-- Preço por sócio só vale em dossie_empresarial (a UI e a action também validam).
create function product_versions_sale_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.sale_price_per_partner <> 0
     and exists (select 1 from public.products p where p.id = new.product_id and p.code = 'dossie_pf') then
    raise exception 'catalog: per-partner price only for dossie_empresarial' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger product_versions_sale_guard before insert on product_versions
  for each row execute function product_versions_sale_guard();

-- Preço vigente: só a ÚLTIMA versão conta e ela precisa ter sale_price. Sem preço, sem linha (falha fechada: nunca
-- cai para uma versão antiga). Roda com os direitos de quem chama (molde de resolve_product_terms).
create function current_product_price(p_product_id uuid)
returns table (product_version_id uuid, sale_price numeric, sale_price_per_partner numeric)
language sql
stable
rows 1
set search_path = pg_catalog, public
as $$
  select s.id, s.sale_price, s.sale_price_per_partner
    from (select v.id, v.sale_price, v.sale_price_per_partner
            from public.product_versions v
           where v.product_id = p_product_id
           order by v.version desc
           limit 1) s
   where s.sale_price is not null
$$;

alter function product_versions_sale_guard() owner to schema_owner;
alter function current_product_price(uuid) owner to schema_owner;
revoke all on function product_versions_sale_guard() from public;
revoke all on function current_product_price(uuid) from public;
grant execute on function current_product_price(uuid) to app_runtime, auth_profile_lookup;

grant select (sale_price, sale_price_per_partner) on product_versions to auth_profile_lookup;

-- 2) % global do Bureau: uma chave em settings, de 0 a 99,99 com até 2 casas, sem valor inicial.
alter table settings add constraint settings_bureau_commission_pct_check check (
  key <> 'bureau_commission_pct'
  or case
       when jsonb_typeof(value) = 'number'
         then (value #>> '{}')::numeric between 0 and 99.99
              and (value #>> '{}')::numeric = round((value #>> '{}')::numeric, 2)
       else false
     end
);
create policy settings_gateway_bureau_commission on settings for select to auth_profile_lookup
  using (key = 'bureau_commission_pct');
-- Em sessão de suporte, ninguém escreve a % global (restritiva: soma-se a settings_superadmin_write).
create policy settings_commission_no_support_insert on settings as restrictive for insert
  with check (key <> 'bureau_commission_pct' or app_support_session_id() is null);
create policy settings_commission_no_support_update on settings as restrictive for update
  using (key <> 'bureau_commission_pct' or app_support_session_id() is null)
  with check (key <> 'bureau_commission_pct' or app_support_session_id() is null);
create policy settings_commission_no_support_delete on settings as restrictive for delete
  using (key <> 'bureau_commission_pct' or app_support_session_id() is null);

-- Override por Bureau (append-only): vale a linha de maior id do Bureau; pct nulo volta ao global.
create table bureau_commission_rates (
  id bigint generated always as identity primary key,
  bureau_id uuid not null references bureaus(id),
  pct numeric(5,2) check (pct is null or (pct >= 0 and pct <= 99.99)),
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create index bureau_commission_rates_bureau_idx on bureau_commission_rates(bureau_id, id desc);
create trigger bureau_commission_rates_immutable before update or delete on bureau_commission_rates
  for each row execute function append_only_guard();
create trigger bureau_commission_rates_no_truncate before truncate on bureau_commission_rates
  for each statement execute function append_only_guard();

-- Bloqueio de produto por Bureau (append-only): vale a linha de maior id do par; sem linha = liberado.
create table bureau_product_blocks (
  id bigint generated always as identity primary key,
  bureau_id uuid not null references bureaus(id),
  product_id uuid not null references products(id),
  blocked boolean not null,
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create index bureau_product_blocks_pair_idx on bureau_product_blocks(bureau_id, product_id, id desc);
create trigger bureau_product_blocks_immutable before update or delete on bureau_product_blocks
  for each row execute function append_only_guard();
create trigger bureau_product_blocks_no_truncate before truncate on bureau_product_blocks
  for each statement execute function append_only_guard();

alter table bureau_commission_rates owner to schema_owner;
alter table bureau_product_blocks owner to schema_owner;
alter table bureau_commission_rates enable row level security;
alter table bureau_commission_rates force row level security;
alter table bureau_product_blocks enable row level security;
alter table bureau_product_blocks force row level security;

-- Leitura: superadmin (sem suporte) e equipe do próprio Bureau. Escrita: só superadmin sem suporte.
create policy bureau_commission_rates_select on bureau_commission_rates for select using (
  app_context_present() and (
    (app_user_role() = 'superadmin' and app_support_session_id() is null)
    or (bureau_id = app_bureau_id() and (select app_is_staff())))
);
create policy bureau_commission_rates_superadmin_insert on bureau_commission_rates for insert with check (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
  and set_by = app_user_id()
);
create policy bureau_product_blocks_select on bureau_product_blocks for select using (
  app_context_present() and (
    (app_user_role() = 'superadmin' and app_support_session_id() is null)
    or (bureau_id = app_bureau_id() and (select app_is_staff())))
);
create policy bureau_product_blocks_superadmin_insert on bureau_product_blocks for insert with check (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
  and set_by = app_user_id()
);

revoke all on bureau_commission_rates, bureau_product_blocks from public, app_runtime, auth_profile_lookup;
grant select, insert on bureau_commission_rates, bureau_product_blocks to app_runtime;
grant select on bureau_commission_rates, bureau_product_blocks to backup_reader;
grant select on bureau_commission_rates, bureau_product_blocks to auth_profile_lookup;
create policy bureau_commission_rates_gateway_select on bureau_commission_rates for select to auth_profile_lookup
  using (true);
create policy bureau_product_blocks_gateway_select on bureau_product_blocks for select to auth_profile_lookup
  using (true);

-- % efetiva do Bureau: o override mais recente (nulo = global) ou a % global; nulo se nenhuma existe. Sem grant a
-- app_runtime: só as funções de liquidação a chamam (a tela lê as tabelas sob RLS).
create function resolve_bureau_commission_pct(p_bureau_id uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select r.pct from public.bureau_commission_rates r where r.bureau_id = p_bureau_id order by r.id desc limit 1),
    (select (s.value #>> '{}')::numeric from public.settings s
      where s.key = 'bureau_commission_pct' and jsonb_typeof(s.value) = 'number'))
$$;

-- Cópia interna (sem grant a app_runtime): as funções de liquidação e o catálogo público a chamam como definer.
create function product_blocked_for_bureau_internal(p_bureau_id uuid, p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select b.blocked from public.bureau_product_blocks b
      where b.bureau_id = p_bureau_id and b.product_id = p_product_id
      order by b.id desc limit 1),
    false)
$$;

-- Versão para app_runtime: só responde pelo Bureau do contexto ou ao superadmin; qualquer outro caso vale "bloqueado"
-- (fecha em caso de dúvida e não revela o bloqueio de outro Bureau).
create function product_blocked_for_bureau(p_bureau_id uuid, p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when nullif(current_setting('app.user_id', true), '') is not null
     and (current_setting('app.user_role', true) = 'superadmin'
          or p_bureau_id = nullif(current_setting('app.bureau_id', true), '')::uuid)
    then public.product_blocked_for_bureau_internal(p_bureau_id, p_product_id)
    else true
  end
$$;

alter function resolve_bureau_commission_pct(uuid) owner to auth_profile_lookup;
alter function product_blocked_for_bureau_internal(uuid, uuid) owner to auth_profile_lookup;
alter function product_blocked_for_bureau(uuid, uuid) owner to auth_profile_lookup;
revoke all on function resolve_bureau_commission_pct(uuid) from public;
revoke all on function product_blocked_for_bureau_internal(uuid, uuid) from public;
revoke all on function product_blocked_for_bureau(uuid, uuid) from public;
grant execute on function product_blocked_for_bureau(uuid, uuid) to app_runtime;

-- 3) Liquidação: snapshot da % e da comissão do Bureau. cost, nos pedidos novos, é a parte da plataforma.
alter table order_settlements
  add column commission_pct numeric(5,2),
  add column bureau_commission numeric(15,2);
alter table order_settlements add constraint order_settlements_commission_check check (
  (commission_pct is null) = (bureau_commission is null)
  and (
    commission_pct is null
    or (commission_pct between 0 and 99.99
        and bureau_commission = round(price * commission_pct / 100, 2)
        and cost = price - bureau_commission)
  )
);
grant insert (commission_pct, bureau_commission) on order_settlements to auth_profile_lookup;

-- 4) Legado só leitura.
drop policy bureau_catalog_items_admin_insert on bureau_catalog_items;
drop policy bureau_catalog_items_admin_update on bureau_catalog_items;
drop policy bureau_product_costs_superadmin_insert on bureau_product_costs;
revoke insert on bureau_product_costs from app_runtime;
drop policy affiliate_rates_admin_insert on affiliate_rates;
drop policy affiliate_rates_admin_update on affiliate_rates;
drop policy affiliate_rates_admin_delete on affiliate_rates;

-- % de afiliados do Bureau (uma para todos): só o superadmin sem suporte escreve; a equipe do Bureau só lê.
drop policy bureau_affiliate_settings_admin_insert on bureau_affiliate_settings;
drop policy bureau_affiliate_settings_admin_update on bureau_affiliate_settings;
create policy bureau_affiliate_settings_superadmin_select on bureau_affiliate_settings for select using (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
);
create policy bureau_affiliate_settings_superadmin_insert on bureau_affiliate_settings for insert with check (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
  and updated_by = app_user_id()
);
create policy bureau_affiliate_settings_superadmin_update on bureau_affiliate_settings for update
  using (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
  with check (
    app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
    and updated_by = app_user_id());

comment on column affiliate_commissions.margin is
  'Base da comissão. Comissão nova (048): preço bruto do pedido. Comissão antiga: margem (preço menos custo). Relatórios usam amount e pct.';

-- Auditoria só junto da linha que a mesma transação escreveu (como audit_nfse_retry_backed, 017): o evento aponta para
-- uma mudança real do Bureau alvo, feita por este autor. Fora do superadmin sem suporte devolve sempre falso.
-- commission.bureau_set: override do Bureau gravado agora. catalog.block_set: bloqueio do produto gravado agora.
-- affiliate.rate: bureau_affiliate_settings do Bureau escrita nesta transação (updated_at = now(); o upsert o grava).
create function audit_commission_backed(p_action text, p_bureau_id uuid, p_record_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_bureau_id is null
     or not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return false;
  end if;
  if p_action = 'commission.bureau_set' then
    return p_record_id = p_bureau_id and exists (
      select 1 from public.bureau_commission_rates r
       where r.bureau_id = p_bureau_id and r.set_by = p_user_id and r.created_at = pg_catalog.now());
  elsif p_action = 'catalog.block_set' then
    return exists (
      select 1 from public.bureau_product_blocks k
       where k.bureau_id = p_bureau_id and k.product_id = p_record_id and k.set_by = p_user_id
         and k.created_at = pg_catalog.now());
  elsif p_action = 'affiliate.rate' then
    return p_record_id = p_bureau_id and exists (
      select 1 from public.bureau_affiliate_settings a
       where a.bureau_id = p_bureau_id and a.updated_by = p_user_id
         and a.updated_at = pg_catalog.now());
  end if;
  return false;
end
$$;
alter function audit_commission_backed(text, uuid, uuid, uuid) owner to auth_profile_lookup;
revoke all on function audit_commission_backed(text, uuid, uuid, uuid) from public;
grant execute on function audit_commission_backed(text, uuid, uuid, uuid) to app_runtime;
grant select (updated_by, updated_at) on bureau_affiliate_settings to auth_profile_lookup;

-- 5) Auditoria: mantém os ramos da 017 e acrescenta, ao do superadmin sem suporte com bureau_id alvo, as ações novas.
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
    or (
      app_user_role() = 'superadmin'
      and app_support_session_id() is null
      and bureau_id is not null
      and (
        (action = 'commission.bureau_set' and table_name = 'bureaus'
          and audit_commission_backed(action, audit_logs.bureau_id, audit_logs.record_id, audit_logs.user_id))
        or (action = 'catalog.block_set' and table_name = 'products'
          and audit_commission_backed(action, audit_logs.bureau_id, audit_logs.record_id, audit_logs.user_id))
        or (action = 'affiliate.rate' and table_name = 'bureau_affiliate_settings'
          and audit_commission_backed(action, audit_logs.bureau_id, audit_logs.record_id, audit_logs.user_id))
      )
    )
  ));

-- 6) public_bureau_catalog (010): produto ativo, com preço na última versão e não bloqueado para o Bureau.
create or replace function public_bureau_catalog(p_slug text)
returns table (code text, name text, sale_price numeric, sale_price_per_partner numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.code, p.name, c.sale_price, c.sale_price_per_partner
    from public.bureaus b
    cross join public.products p
    cross join lateral public.current_product_price(p.id) c
   where b.slug = p_slug and b.status = 'active' and p.active
     and not public.product_blocked_for_bureau_internal(b.id, p.id)
   order by p.name
$$;

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
  -- O Titular consultado é um Titular do comprador: pesquisa própria dele (online: v_self; balcão: achado pelo documento).
  v_subject_is_buyer boolean := false;
  v_partner_is_buyer boolean;
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
  -- Balcão com comprador: o documento do Titular casa com um Titular da conta dele. É a pesquisa própria do comprador:
  -- o servidor usa o e-mail da conta e o celular confirmado, e o contato digitado é descartado (sem D12).
  if v_mode = 'counter' and v_buyer is not null and v_digits <> '' then
    select h.id, h.type::text as type, h.document_digits, h.name into v_own
      from public.holders h
     where h.bureau_id = v_bureau and h.client_profile_id = v_buyer and h.document_digits = v_digits
     order by h.created_at, h.id limit 1;
    v_subject_is_buyer := found;
  end if;
  v_subject_is_buyer := v_subject_is_buyer or v_self;
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
  if v_subject_is_buyer then
    v_digits := v_own.document_digits;
    v_name := left(btrim(v_own.name), 200);
  elsif p_subject_type is null or p_subject_type not in ('PF', 'PJ') or length(v_digits) not in (11, 14)
        or v_name = '' or length(v_name) > 200 then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  -- 3) Produto à venda no Bureau: produto ativo, última versão com preço de venda (definido pelo superadmin) e produto
  -- não bloqueado para este Bureau.
  select p.id, c.sale_price, c.product_version_id, v.deps_product into v_main
    from public.products p
    cross join lateral public.current_product_price(p.id) c
    join public.product_versions v on v.id = c.product_version_id
   where p.code = p_product_code and p.active
     and not public.product_blocked_for_bureau_internal(v_bureau, p.id);
  if not found or v_main.deps_product is null then
    return query select false, 'product_not_for_sale'::text, null::uuid, null::text;
    return;
  end if;

  -- 4) Tipo: dossie_pf é de Titular PF (11 dígitos); dossie_empresarial, de Titular PJ (14 dígitos).
  v_type := case when p_product_code = 'dossie_pf' then 'PF' else 'PJ' end;
  -- v_own só existe na pesquisa própria: o plpgsql não garante curto-circuito, então o ramo é um if.
  if v_subject_is_buyer then
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
  if v_subject_is_buyer then
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
      -- D12: o sócio pode ter o e-mail do comprador só se o documento dele for o de um Titular da conta do comprador
      -- (portal ou balcão). Para qualquer outro sócio, nunca.
      if v_buyer is not null then
        select exists (
          select 1 from public.holders h
           where h.bureau_id = v_bureau and h.client_profile_id = v_buyer and h.document_digits = v_pdigits)
          into v_partner_is_buyer;
        if v_pemail = lower(v_buyer_p.email) and not v_partner_is_buyer then
          return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
          return;
        end if;
        if v_partner_is_buyer then
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
    if v_subject_is_buyer then
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
        if not (v_subject_is_buyer and v_i = 0) then
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
                               'members', jsonb_array_length(v_members), 'self_member', v_subject_is_buyer or v_self_member)
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

-- reserve_order (022): preço e custo vêm do preço de venda do produto e da % do Bureau (048).
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
  v_pct numeric;
  v_commission numeric;
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
  -- principal, preço de venda da última versão do produto (valor base + valor por sócio). A comissão do Bureau é a %
  -- efetiva (override ou global) sobre o preço bruto; o custo gravado é a parte da plataforma (preço menos comissão).
  -- A cotação do chamador só é conferida pelo total; as linhas gravadas são as montadas aqui.
  select o.product_code into v_code from public.dossier_orders o where o.dossier_id = p_order_ref;
  select greatest(count(*) - 1, 0) into v_partners from public.consultations c where c.dossier_id = p_order_ref;
  select p.id, c.product_version_id, c.sale_price, c.sale_price_per_partner
    into v_item
    from public.products p
    cross join lateral public.current_product_price(p.id) c
   where p.code = v_code and p.active
     and not public.product_blocked_for_bureau_internal(v_bureau, p.id);
  v_valid := found;
  v_fail := 'quote_mismatch';
  if v_valid then
    v_pct := public.resolve_bureau_commission_pct(v_bureau);
    if v_pct is null then
      v_valid := false;
      v_fail := 'commission_not_configured';
    end if;
  end if;
  if v_valid then
    v_price := v_item.sale_price + v_item.sale_price_per_partner * v_partners;
    v_commission := round(v_price * v_pct / 100, 2);
    v_cost := v_price - v_commission;
    v_lines := jsonb_build_array(jsonb_build_object(
      'productVersionId', v_item.product_version_id, 'code', v_code, 'part', 'base', 'quantity', 1,
      'unitPriceCents', (v_item.sale_price * 100)::bigint, 'priceCents', (v_item.sale_price * 100)::bigint));
    if v_partners > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'productVersionId', v_item.product_version_id, 'code', v_code, 'part', 'partner', 'quantity', v_partners,
        'unitPriceCents', (v_item.sale_price_per_partner * 100)::bigint,
        'priceCents', (v_item.sale_price_per_partner * v_partners * 100)::bigint));
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
    insert into public.order_settlements
      (order_ref, bureau_id, mode, client_profile_id, price, cost, quote, commission_pct, bureau_commission)
    values (p_order_ref, v_bureau, p_mode, p_client_profile_id, p_price,
      case when v_valid then v_cost else p_cost end,
      jsonb_build_object('lines', v_lines),
      case when v_valid then v_pct end, case when v_valid then v_commission end)
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

-- capture_order (027): ramo novo quando commission_pct está gravado (048); o ramo antigo continua igual.
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
  v_amount numeric;
  v_reserved numeric;
  v_margin numeric;
  v_accrual numeric;
  v_commission numeric;
  v_affiliate uuid;
  v_pct numeric;
  v_hold_days integer;
  v_commission_id uuid;
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

  -- Valor que a captura tira da reserva e o que ainda resta da reserva deste pedido (a carteira travada; ver
  -- order_reservation_left). Balcão com custo 0 não toca a carteira (v_reserved fica nulo).
  v_amount := case when v_s.mode = 'online' then v_s.price else v_s.cost end;
  if v_s.mode = 'online' then
    select reserved into v_reserved from public.client_wallets
     where client_profile_id = v_s.client_profile_id for update;
  elsif v_s.cost > 0 then
    select reserved into v_reserved from public.wallets where bureau_id = v_s.bureau_id for update;
  end if;
  if v_reserved is not null then
    v_reserved := public.order_reservation_left(v_s.order_ref, v_reserved);
  end if;

  if v_reserved < v_amount then
    -- Um estorno de PIX retomou a reserva deste pedido: não há o que capturar. Devolve o que sobrou dela e fecha o pedido.
    if v_reserved > 0 then
      if v_s.mode = 'online' then
        select * into v_post from public.client_wallet_post_entry(
          v_s.client_profile_id, 'release', v_reserved, 'order:release:' || p_order_ref::text,
          'order:' || p_order_ref::text, null, v_user);
      else
        select * into v_post from public.wallet_post_entry(
          v_s.bureau_id, 'release', v_reserved, 'order:release:' || p_order_ref::text,
          'order:' || p_order_ref::text, null, v_user);
      end if;
      if not v_post.ok then
        raise exception 'order release failed: %', v_post.reason;
      end if;
    end if;
    update public.order_settlements set status = 'released', closed_at = now() where id = v_s.id;
    return query select false, 'reservation_clawed_back'::text, 'released'::text;
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

    -- Comissão: só se o indicado tem telefone verificado e o afiliado está ativo e não foi anonimizado. A % vale na
    -- captura e fica gravada na comissão: mudá-la depois não altera o passado. O perfil do afiliado é lido com
    -- "for share": a anonimização (que o trava "for no key update") e esta captura se enfileiram, e a comissão nunca nasce
    -- depois de a conta ser anonimizada.
    -- Base da comissão do afiliado: pedido novo (commission_pct gravado) = preço bruto; pedido antigo = margem (preço
    -- menos custo de atacado). O ramo antigo segue o de 027 (affiliate_rates e bureau_affiliate_settings).
    v_margin := case when v_s.commission_pct is null then v_s.price - v_s.cost else v_s.price end;
    v_commission := 0;
    select r.affiliate_profile_id into v_affiliate
      from public.affiliate_referrals r
      join public.profiles a on a.id = r.affiliate_profile_id
      join public.profiles b on b.id = r.referred_profile_id
     where r.referred_profile_id = v_s.client_profile_id
       and a.anonymized_at is null and a.is_active and b.phone_verified_at is not null
       for share of a;
    if v_affiliate is not null and v_margin > 0 then
      if v_s.commission_pct is null then
        v_pct := coalesce(
          (select pct from public.affiliate_rates where bureau_id = v_s.bureau_id and affiliate_profile_id = v_affiliate),
          (select default_pct from public.bureau_affiliate_settings where bureau_id = v_s.bureau_id), 0);
        v_commission := round(v_pct * v_margin / 100, 2);
      else
        -- Uma % de afiliados por Bureau. Arredonda sozinha; o least garante que a plataforma não fique negativa
        -- (bureau + afiliado <= preço). A plataforma absorve o centavo.
        v_pct := coalesce((select default_pct from public.bureau_affiliate_settings where bureau_id = v_s.bureau_id), 0);
        v_commission := least(round(v_pct * v_margin / 100, 2), v_s.price - v_s.bureau_commission);
      end if;
    end if;
    -- Pedido novo: o Bureau recebe a comissão gravada, sem descontar a do afiliado (sai da parte da plataforma).
    v_accrual := case when v_s.commission_pct is null then v_margin - v_commission else v_s.bureau_commission end;
    if v_accrual > 0 then
      insert into public.bureau_payable_entries (bureau_id, kind, amount, order_ref)
      values (v_s.bureau_id, 'accrual', v_accrual, v_s.order_ref);
    end if;
    if v_commission > 0 then
      select greatest(floor((value #>> '{}')::numeric)::integer, 0) into v_hold_days
        from public.settings where key = 'affiliate_commission_hold_days' and jsonb_typeof(value) = 'number';
      insert into public.affiliate_commissions
        (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, release_at)
      values
        (v_s.order_ref, v_s.bureau_id, v_affiliate, v_s.client_profile_id, v_pct, v_margin, v_commission,
         now() + make_interval(days => coalesce(v_hold_days, 30)))
      returning id into v_commission_id;
      -- O livro do afiliado não guarda o id do indicado: created_by é o próprio afiliado e a referência é a comissão.
      select * into v_post from public.affiliate_wallet_post_entry(
        v_affiliate, 'commission', v_commission, 'order:commission:' || p_order_ref::text,
        'commission:' || v_commission_id::text, v_affiliate);
      if not v_post.ok then
        raise exception 'affiliate commission failed: %', v_post.reason;
      end if;
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_s.bureau_id, v_user, 'affiliate.commission', 'affiliate_commissions', v_commission_id,
        jsonb_build_object('order_ref', v_s.order_ref, 'pct', v_pct::text, 'amount', v_commission::text));
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
