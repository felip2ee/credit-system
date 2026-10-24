-- M2: catálogo e preços.
-- products e product_versions são globais (modelo de settings). bureau_product_costs
-- e bureau_catalog_items são de tenant. Exceção ao M1: o superadmin lê e insere
-- bureau_product_costs sem sessão de suporte (custo não é dado pessoal).
-- public_bureau_catalog segue o padrão de 009: dono auth_profile_lookup (NOBYPASSRLS),
-- com grants de coluna e políticas de gateway; schema_owner sofre FORCE RLS e não leria nada.

create table products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{3,60}$'),
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  version integer not null check (version > 0),
  deps_product text check (deps_product is null or btrim(deps_product) <> ''),
  base_cost numeric(15,2) not null check (base_cost >= 0 and base_cost <= 99999999.99),
  base_cost_per_partner numeric(15,2) not null default 0
    check (base_cost_per_partner >= 0 and base_cost_per_partner <= 99999999.99),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (product_id, version)
);

create function product_versions_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'product_versions is immutable' using errcode = 'check_violation';
end
$$;

create trigger product_versions_immutable before update or delete on product_versions
  for each row execute function product_versions_immutable();

-- id cresce sempre: desempata dois overrides na mesma transação (now() é igual).
create table bureau_product_costs (
  id bigint generated always as identity primary key,
  bureau_id uuid not null references bureaus(id),
  product_id uuid not null references products(id),
  cost numeric(15,2) not null check (cost >= 0 and cost <= 99999999.99),
  cost_per_partner numeric(15,2) not null default 0
    check (cost_per_partner >= 0 and cost_per_partner <= 99999999.99),
  set_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create index bureau_product_costs_bureau_product_idx
  on bureau_product_costs(bureau_id, product_id, id desc);

create table bureau_catalog_items (
  bureau_id uuid not null references bureaus(id),
  product_id uuid not null references products(id),
  active boolean not null default false,
  sale_price numeric(15,2) not null check (sale_price > 0 and sale_price <= 99999999.99),
  sale_price_per_partner numeric(15,2) not null default 0
    check (sale_price_per_partner >= 0 and sale_price_per_partner <= 99999999.99),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (bureau_id, product_id),
  foreign key (bureau_id, updated_by) references profiles(bureau_id, id)
);

create trigger bureau_catalog_items_updated_at before update on bureau_catalog_items
  for each row execute function set_updated_at();

-- Custo efetivo (base e por sócio) = override mais recente do Bureau, senão os valores da versão vigente.
-- Roda com os direitos de quem chama: o RLS decide o que cada papel enxerga.
create function resolve_product_terms(p_bureau_id uuid, p_product_id uuid)
returns table (product_version_id uuid, effective_cost numeric, effective_cost_per_partner numeric)
language sql
stable
rows 1
set search_path = pg_catalog, public
as $$
  select v.id, coalesce(c.cost, v.base_cost), coalesce(c.cost_per_partner, v.base_cost_per_partner)
    from public.product_versions v
    left join lateral (
      select bc.cost, bc.cost_per_partner from public.bureau_product_costs bc
       where bc.bureau_id = p_bureau_id and bc.product_id = p_product_id
       order by bc.id desc
       limit 1) c on true
   where v.product_id = p_product_id
   order by v.version desc
   limit 1
$$;

-- Falha fechada no SQL: repete a regra de preço (por campo) e a do valor por sócio.
-- Um UPDATE que não muda preço nem ativa o item passa (permite desativar quando o custo subiu).
create function bureau_catalog_items_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_product public.products;
  v_cost numeric;
  v_cost_per_partner numeric;
begin
  if tg_op = 'UPDATE' and new.sale_price = old.sale_price
     and new.sale_price_per_partner = old.sale_price_per_partner
     and not (new.active and not old.active) then
    return new;
  end if;

  select * into v_product from public.products where id = new.product_id;
  select t.effective_cost, t.effective_cost_per_partner into v_cost, v_cost_per_partner
    from public.resolve_product_terms(new.bureau_id, new.product_id) t;
  if v_cost is null then
    raise exception 'catalog: product has no version' using errcode = 'check_violation';
  end if;
  if v_product.code = 'dossie_pf' and new.sale_price_per_partner <> 0 then
    raise exception 'catalog: per-partner price only for dossie_empresarial'
      using errcode = 'check_violation';
  end if;
  if new.sale_price < v_cost then
    raise exception 'catalog: sale price below effective cost' using errcode = 'check_violation';
  end if;
  if new.sale_price_per_partner < v_cost_per_partner then
    raise exception 'catalog: partner price below partner cost' using errcode = 'check_violation';
  end if;

  if new.active and not v_product.active then
    raise exception 'catalog: product is inactive' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger bureau_catalog_items_guard before insert or update on bureau_catalog_items
  for each row execute function bureau_catalog_items_guard();

alter table products enable row level security;
alter table products force row level security;
alter table product_versions enable row level security;
alter table product_versions force row level security;
alter table bureau_product_costs enable row level security;
alter table bureau_product_costs force row level security;
alter table bureau_catalog_items enable row level security;
alter table bureau_catalog_items force row level security;

create policy products_select on products for select
  using (app_context_present() and app_user_role() in ('superadmin', 'bureau_admin', 'operator'));
create policy products_superadmin_write on products for all
  using (app_context_present() and app_user_role() = 'superadmin')
  with check (app_context_present() and app_user_role() = 'superadmin');

create policy product_versions_select on product_versions for select
  using (app_context_present() and app_user_role() in ('superadmin', 'bureau_admin', 'operator'));
create policy product_versions_superadmin_insert on product_versions for insert
  with check (
    app_context_present() and app_user_role() = 'superadmin'
    and created_by = app_user_id()
  );

create policy bureau_product_costs_select on bureau_product_costs for select
  using (
    app_context_present()
    and (
      app_user_role() = 'superadmin'
      or (app_user_role() in ('bureau_admin', 'operator') and bureau_id = app_bureau_id())
    )
  );
create policy bureau_product_costs_superadmin_insert on bureau_product_costs for insert
  with check (
    app_context_present() and app_user_role() = 'superadmin'
    and set_by = app_user_id()
  );

create policy bureau_catalog_items_select on bureau_catalog_items for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy bureau_catalog_items_admin_insert on bureau_catalog_items for insert
  with check (
    bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin'
    and (select app_is_staff()) and updated_by = app_user_id()
  );
create policy bureau_catalog_items_admin_update on bureau_catalog_items for update
  using (
    bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff())
  )
  with check (
    bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin'
    and (select app_is_staff()) and updated_by = app_user_id()
  );

-- Public gateway: SECURITY DEFINER sem BYPASSRLS, só colunas e linhas necessárias.
create function public_bureau_catalog(p_slug text)
returns table (code text, name text, sale_price numeric, sale_price_per_partner numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.code, p.name, i.sale_price, i.sale_price_per_partner
    from public.bureaus b
    join public.bureau_catalog_items i on i.bureau_id = b.id and i.active
    join public.products p on p.id = i.product_id and p.active
    cross join lateral public.resolve_product_terms(b.id, p.id) t
   where b.slug = p_slug and b.status = 'active'
     and i.sale_price >= t.effective_cost
     and i.sale_price_per_partner >= t.effective_cost_per_partner
   order by p.name
$$;

alter table products owner to schema_owner;
alter table product_versions owner to schema_owner;
alter table bureau_product_costs owner to schema_owner;
alter table bureau_catalog_items owner to schema_owner;
alter function product_versions_immutable() owner to schema_owner;
alter function resolve_product_terms(uuid, uuid) owner to schema_owner;
alter function bureau_catalog_items_guard() owner to schema_owner;
alter function public_bureau_catalog(text) owner to auth_profile_lookup;

revoke all on function product_versions_immutable() from public;
revoke all on function bureau_catalog_items_guard() from public;
revoke all on function resolve_product_terms(uuid, uuid) from public;
revoke all on function public_bureau_catalog(text) from public;
grant execute on function resolve_product_terms(uuid, uuid) to app_runtime, auth_profile_lookup;
grant execute on function public_bureau_catalog(text) to app_runtime;

revoke all on products, product_versions, bureau_product_costs, bureau_catalog_items
  from public, app_runtime, auth_profile_lookup;
grant select, insert, update (name, active) on products to app_runtime;
grant select, insert on product_versions to app_runtime;
grant select, insert on bureau_product_costs to app_runtime;
grant select, insert, update (active, sale_price, sale_price_per_partner, updated_by)
  on bureau_catalog_items to app_runtime;
grant select on products, product_versions, bureau_product_costs, bureau_catalog_items
  to backup_reader;

grant select (id, code, name, active) on products to auth_profile_lookup;
grant select (id, product_id, version, base_cost, base_cost_per_partner) on product_versions to auth_profile_lookup;
grant select (id, bureau_id, product_id, cost, cost_per_partner) on bureau_product_costs to auth_profile_lookup;
grant select (bureau_id, product_id, active, sale_price, sale_price_per_partner)
  on bureau_catalog_items to auth_profile_lookup;

create policy products_gateway_select on products for select to auth_profile_lookup
  using (true);
create policy product_versions_gateway_select on product_versions for select to auth_profile_lookup
  using (true);
create policy bureau_product_costs_gateway_select on bureau_product_costs for select to auth_profile_lookup
  using (true);
create policy bureau_catalog_items_gateway_select on bureau_catalog_items for select to auth_profile_lookup
  using (true);

-- Seed: custo 0.00; o superadmin ajusta antes de vender. Nomes DEPS repetem src/lib/deps/products.ts.
-- O Dossiê Empresarial cobra o valor base (empresa) mais o valor por sócio.
-- Produtos nascem inativos: o superadmin define o custo e ativa. Custo 0 só por escolha explícita.
insert into products (code, name, active) values
  ('dossie_pf', 'Dossiê Pessoa Física', false),
  ('dossie_empresarial', 'Dossiê Empresarial Estruturado', false);

insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner)
select p.id, 1, d.deps_product, 0.00, 0.00
  from products p
  join (values
    ('dossie_pf', 'Smart PF 002'),
    ('dossie_empresarial', 'Smart PJ 010')
  ) as d(code, deps_product) on d.code = p.code;
