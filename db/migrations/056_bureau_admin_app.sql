-- App do admin do bureau.
-- 1) bureau_page_views: visitas diárias agregadas de /b/<slug>. Sem IP, sem cookie. Escrita só por record_bureau_page_view.
-- 2) bureau_slug_history: slugs antigos para o redirect 308. Escrita só do superadmin; leitura pública por função.
-- 3) payment_links: link de pagamento /pagar/<token>. Só o hash do token fica no banco. Leitura pública por função;
--    baixa pelo webhook por payment_link_mark_paid (app_webhook não tem privilégio em tabela).
-- 4) app_runtime ganha UPDATE (slug) em bureaus (a política bureaus_update já limita ao superadmin).

create table bureau_page_views (
  bureau_id uuid not null references bureaus(id),
  day date not null,
  count integer not null default 0 check (count >= 0),
  primary key (bureau_id, day)
);

create table bureau_slug_history (
  old_slug text primary key check (old_slug ~ '^[a-z0-9-]{3,40}$'),
  bureau_id uuid not null references bureaus(id),
  changed_at timestamptz not null default now()
);
create index bureau_slug_history_bureau_idx on bureau_slug_history(bureau_id);

create table payment_links (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  order_id uuid not null references dossier_orders(dossier_id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'paid', 'expired', 'cancelled')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint payment_links_paid_at check ((status = 'paid') = (paid_at is not null)),
  -- O pedido tem de ser do mesmo bureau: a FK simples não passa pela RLS.
  foreign key (bureau_id, order_id) references dossiers(bureau_id, id),
  foreign key (bureau_id, created_by) references profiles(bureau_id, id)
);
-- Um link ativo por consulta. Links expirados pelo relógio continuam 'active' até alguém marcá-los 'expired'.
create unique index payment_links_order_active_idx on payment_links(order_id) where status = 'active';
create index payment_links_bureau_created_idx on payment_links(bureau_id, created_at desc);

alter table bureau_page_views enable row level security;
alter table bureau_page_views force row level security;
alter table bureau_slug_history enable row level security;
alter table bureau_slug_history force row level security;
alter table payment_links enable row level security;
alter table payment_links force row level security;

create policy bureau_page_views_staff_select on bureau_page_views for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));

create policy bureau_slug_history_select on bureau_slug_history for select
  using (app_context_present() and (app_user_role() = 'superadmin' or bureau_id = app_bureau_id()));
create policy bureau_slug_history_insert on bureau_slug_history for insert
  with check (app_context_present() and app_user_role() = 'superadmin');
create policy bureau_slug_history_delete on bureau_slug_history for delete
  using (app_context_present() and app_user_role() = 'superadmin');

create policy payment_links_staff_select on payment_links for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy payment_links_staff_insert on payment_links for insert
  with check (bureau_id = app_bureau_id() and (select app_is_staff())
    and created_by = app_user_id() and status = 'active' and paid_at is null);
-- O app cancela ou expira link ativo. 'paid' só pela função do webhook.
create policy payment_links_staff_update on payment_links for update
  using (bureau_id = app_bureau_id() and (select app_is_staff()) and status = 'active')
  with check (bureau_id = app_bureau_id() and status in ('expired', 'cancelled'));

-- auth_profile_lookup é NOBYPASSRLS (009): as funções abaixo só enxergam o que estas políticas liberam.
create policy bureau_page_views_gateway_select on bureau_page_views for select to auth_profile_lookup using (true);
create policy bureau_page_views_gateway_insert on bureau_page_views for insert to auth_profile_lookup with check (true);
create policy bureau_page_views_gateway_update on bureau_page_views for update to auth_profile_lookup
  using (true) with check (true);
create policy bureau_slug_history_gateway_select on bureau_slug_history for select to auth_profile_lookup using (true);
create policy payment_links_gateway_select on payment_links for select to auth_profile_lookup using (true);
create policy payment_links_gateway_update on payment_links for update to auth_profile_lookup
  using (status = 'active') with check (status = 'paid');

grant select on bureau_page_views to app_runtime;
grant select, insert, delete on bureau_slug_history to app_runtime;
grant select, insert, update (status) on payment_links to app_runtime;
grant update (slug) on bureaus to app_runtime;

-- Funções públicas: dono auth_profile_lookup, padrão de 009 (public_bureau_by_slug).
grant select on bureau_page_views, bureau_slug_history, payment_links to auth_profile_lookup;
grant insert, update (count) on bureau_page_views to auth_profile_lookup;
grant update (status, paid_at) on payment_links to auth_profile_lookup;
grant select (dossier_id, product_code, subject_document_masked) on dossier_orders to auth_profile_lookup;
grant select (order_ref, price) on order_settlements to auth_profile_lookup;

-- Conta uma visita. Bureau inexistente ou inativo não grava nada. Devolve se gravou.
create function record_bureau_page_view(p_bureau_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.bureaus b where b.id = p_bureau_id and b.status = 'active') then
    return false;
  end if;
  insert into public.bureau_page_views (bureau_id, day, count)
  values (p_bureau_id, current_date, 1)
  on conflict (bureau_id, day) do update set count = public.bureau_page_views.count + 1;
  return true;
end
$$;

-- Slug atual do bureau ativo que já teve p_old_slug. Vazio se o slug nunca existiu ou voltou a ser um slug atual.
create function public_bureau_slug_redirect(p_old_slug text)
returns table (slug text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.slug from public.bureau_slug_history h
    join public.bureaus b on b.id = h.bureau_id
   where h.old_slug = p_old_slug and b.status = 'active'
$$;

-- Resolve o token (hash SHA-256 em hex) para a página pública. Devolve só o que a página mostra.
-- A página decide por status e expires_at; esta função não filtra nem altera.
create function public_payment_link_by_hash(p_token_hash text)
returns table (
  link_id uuid, bureau_id uuid, order_id uuid, status text, expires_at timestamptz,
  bureau_name text, product_code text, subject_document_masked text, amount numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id, l.bureau_id, l.order_id, l.status, l.expires_at,
         b.name, o.product_code, o.subject_document_masked, s.price
    from public.payment_links l
    join public.bureaus b on b.id = l.bureau_id and b.status = 'active'
    join public.dossier_orders o on o.dossier_id = l.order_id
    left join public.order_settlements s on s.order_ref = l.order_id
   where l.token_hash = p_token_hash
$$;

-- Baixa do webhook: marca 'paid' o link ativo do pedido, mesmo vencido pelo relógio (a cobrança Pix nasceu antes).
create function payment_link_mark_paid(p_order_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.payment_links
     set status = 'paid', paid_at = now()
   where order_id = p_order_id and status = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

alter function record_bureau_page_view(uuid) owner to auth_profile_lookup;
alter function public_bureau_slug_redirect(text) owner to auth_profile_lookup;
alter function public_payment_link_by_hash(text) owner to auth_profile_lookup;
alter function payment_link_mark_paid(uuid) owner to auth_profile_lookup;
revoke all on function record_bureau_page_view(uuid) from public;
revoke all on function public_bureau_slug_redirect(text) from public;
revoke all on function public_payment_link_by_hash(text) from public;
revoke all on function payment_link_mark_paid(uuid) from public;
grant execute on function record_bureau_page_view(uuid) to app_runtime;
grant execute on function public_bureau_slug_redirect(text) to app_runtime;
grant execute on function public_payment_link_by_hash(text) to app_runtime;
grant execute on function payment_link_mark_paid(uuid) to app_webhook;
