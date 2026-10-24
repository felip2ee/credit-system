-- Operações do cliente sobre o próprio pedido (Dossiês PF e Empresarial).
-- 1) cancel_client_order: o cliente cancela o pedido em 'awaiting_authorization' ou 'ready'; a reserva volta ao saldo.
-- 2) client_order_members: lista os membros do pedido (empresa, sócios) com o estado da autorização, documento mascarado.
-- 3) Declaração do comprador: texto versionado em legal_documents, aceite por pedido em order_declarations (imutável),
--    gravado por record_order_declaration.
-- O cliente não tem política em scr_authorizations, holders nem UPDATE em dossier_orders: toda escrita e a leitura dos
-- membros passam por função SECURITY DEFINER (dono auth_profile_lookup) que confere a posse do pedido em SQL.

-- Novo motivo de encerramento.
alter table dossier_orders drop constraint dossier_orders_state_reason_check;
alter table dossier_orders add constraint dossier_orders_state_reason_check
  check (state_reason is null or state_reason in ('scr_refused', 'scr_expired', 'payment_timeout',
    'cancelled_by_staff', 'cancelled_by_client', 'deps_no_data', 'deps_incompatible', 'deps_unavailable',
    'reservation_clawed_back'));

-- Declaração do comprador.
alter table legal_documents drop constraint legal_documents_kind_check;
alter table legal_documents add constraint legal_documents_kind_check
  check (kind in ('terms', 'privacy', 'buyer_declaration'));

create table order_declarations (
  dossier_id uuid primary key references dossier_orders (dossier_id),
  bureau_id uuid not null,
  profile_id uuid not null,
  document_id uuid not null references legal_documents (id),
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  foreign key (bureau_id, profile_id) references profiles (bureau_id, id)
);
create index order_declarations_profile_idx on order_declarations (profile_id);
create trigger order_declarations_immutable before update or delete on order_declarations
  for each row execute function append_only_guard();
create trigger order_declarations_no_truncate before truncate on order_declarations
  for each statement execute function append_only_guard();

-- Sementes. Texto provisório: a versão aprovada entra como nova versão antes de abrir o cadastro ao público.
insert into legal_documents (kind, version, title, body_md) values (
  'buyer_declaration', 1, 'Declaração do comprador',
  $md$> **TEXTO PROVISÓRIO — revisar com o jurídico.**

Declaro que os e-mails e os celulares informados neste pedido pertencem às pessoas indicadas, e que essas pessoas sabem do pedido de consulta. Respondo por qualquer informação falsa que eu fornecer.$md$
);
insert into legal_documents (kind, version, title, body_md) values (
  'terms', 2, 'Termos de Uso',
  $md$> **TEXTO PROVISÓRIO — revisar com o jurídico.** Este texto será substituído pela versão aprovada antes da abertura do cadastro ao público.

## 1. Objeto

Estes termos regem o uso da plataforma de crédito da Rainha do Crédito. Ao criar uma conta, você declara que leu e aceita estas regras.

## 2. Conta

Você informa dados verdadeiros no cadastro e mantém sua senha em sigilo. Você responde pelo que acontece na sua conta. Avise-nos se achar que alguém usou a conta sem sua permissão.

## 3. Dados tratados

Tratamos os dados do cadastro e das consultas que você pede, só para prestar o serviço. A Política de Privacidade explica o uso em detalhes.

## 4. Direitos do titular

Pela LGPD, você pode pedir acesso, correção e exclusão dos seus dados, e pode revogar seu consentimento.

## 5. Pedidos com outras pessoas

Ao pedir uma pesquisa que envolve outras pessoas (por exemplo, os sócios de uma empresa), você declara que os e-mails e os celulares informados pertencem às pessoas indicadas. Você responde por qualquer informação falsa que fornecer. Cada pessoa precisa autorizar a consulta dos seus dados.

## 6. Contato

Dúvidas e pedidos: contato@rainhadocredito.com.$md$
);

alter table order_declarations owner to schema_owner;
alter table order_declarations enable row level security;
alter table order_declarations force row level security;
revoke all on order_declarations from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
grant select on order_declarations to app_runtime, backup_reader;
grant insert on order_declarations to auth_profile_lookup;

create policy order_declarations_client_select on order_declarations for select
  using (app_context_present() and app_user_role() = 'client'
         and bureau_id = app_bureau_id() and profile_id = app_user_id());
create policy order_declarations_staff_select on order_declarations for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy order_declarations_gateway_insert on order_declarations for insert to auth_profile_lookup
  with check (bureau_id = app_bureau_id() and profile_id = app_user_id());

-- Cancelamento pelo cliente: o mesmo que cancelOrder faz para a equipe (estado, dossiê, consultas, reserva, trilha).
create function cancel_client_order(p_dossier_id uuid)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_o public.dossier_orders;
  v_holder uuid;
  v_release record;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null or p_dossier_id is null
     or public.app_user_role() is distinct from 'client' then
    return query select false, 'not_found'::text;
    return;
  end if;

  select * into v_o from public.dossier_orders o
   where o.dossier_id = p_dossier_id and o.bureau_id = v_bureau and o.client_profile_id = v_user
   for update;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if v_o.state not in ('awaiting_authorization', 'ready') then
    return query select false, 'invalid_state'::text;
    return;
  end if;

  -- Falha na liberação aborta a transação: o pedido nunca fecha com a reserva presa.
  select * into v_release from public.release_order(p_dossier_id);
  if not v_release.ok then
    raise exception 'cancel_client_order: release failed (%)', v_release.reason;
  end if;

  update public.dossier_orders
     set state = 'cancelled', state_reason = 'cancelled_by_client', lease_until = null, updated_at = now()
   where dossier_id = p_dossier_id;
  update public.dossiers set status = 'cancelled' where id = p_dossier_id and bureau_id = v_bureau;
  update public.consultations set status = 'rejected'
   where dossier_id = p_dossier_id and bureau_id = v_bureau and status = 'pending_authorization';

  select d.holder_id into v_holder from public.dossiers d where d.id = p_dossier_id;
  if v_holder is not null then
    insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata, created_by)
    values (v_bureau, 'holder', v_holder, 'order.cancelled', 'Pedido de pesquisa cancelado',
            jsonb_build_object('dossier_id', p_dossier_id), v_user);
  end if;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user, 'order.cancel', 'dossier_orders', p_dossier_id,
          jsonb_build_object('reason', 'cancelled_by_client'));

  return query select true, null::text;
end
$$;

-- Membros do pedido próprio. Pedido de outro cliente, de outro Bureau ou chamada de equipe devolvem zero linhas.
-- Documento sempre mascarado; o completo nunca sai.
create function client_order_members(p_dossier_id uuid)
returns table (role text, name text, document_masked text, scr_status text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present() or public.app_bureau_id() is null or p_dossier_id is null
     or public.app_user_role() is distinct from 'client' then
    return;
  end if;
  return query
    select
      (case when c.holder_id = d.holder_id
            then case when o.product_code = 'dossie_empresarial' then 'company' else 'subject' end
            else 'partner' end)::text,
      h.name::text,
      coalesce(public.order_mask_document(h.document_digits), '—')::text,
      (case
         when s.id is null then 'pending'
         when s.status = 'not_authorized' then 'refused'
         when s.status = 'expired' then 'expired'
         when s.status = 'authorized' then
           case when s.expires_at is not null and s.expires_at <= now() then 'expired' else 'authorized' end
         when coalesce(s.request_expires_at, s.expires_at) <= now() then 'expired'
         else 'pending'
       end)::text
      from public.dossier_orders o
      join public.dossiers d on d.id = o.dossier_id
      join public.consultations c on c.dossier_id = o.dossier_id and c.bureau_id = o.bureau_id
      join public.holders h on h.id = c.holder_id
      left join public.scr_authorizations s on s.id = c.scr_authorization_id
     where o.dossier_id = p_dossier_id
       and o.bureau_id = public.app_bureau_id()
       and o.client_profile_id = public.app_user_id()
     order by (c.holder_id <> d.holder_id), h.name, c.id;
end
$$;

-- Declaração do comprador: só a versão vigente vale; uma por pedido.
create function record_order_declaration(p_dossier_id uuid, p_version integer, p_ip inet, p_user_agent text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_doc uuid;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null or p_dossier_id is null
     or public.app_user_role() is distinct from 'client' then
    return query select false, 'not_found'::text;
    return;
  end if;
  perform 1 from public.dossier_orders o
   where o.dossier_id = p_dossier_id and o.bureau_id = v_bureau and o.client_profile_id = v_user;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if p_version is distinct from public.legal_current_version('buyer_declaration') then
    return query select false, 'outdated'::text;
    return;
  end if;

  select l.id into v_doc from public.legal_documents l where l.kind = 'buyer_declaration' and l.version = p_version;
  -- Segunda gravação do mesmo pedido: a chave primária recusa (23505) e a transação volta.
  insert into public.order_declarations (dossier_id, bureau_id, profile_id, document_id, ip, user_agent)
  values (p_dossier_id, v_bureau, v_user, v_doc, p_ip, left(p_user_agent, 512));
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata, ip_address, user_agent)
  values (v_bureau, v_user, 'order.declaration_accepted', 'dossier_orders', p_dossier_id,
          jsonb_build_object('version', p_version), p_ip, left(p_user_agent, 512));
  return query select true, null::text;
end
$$;

alter function cancel_client_order(uuid) owner to auth_profile_lookup;
alter function client_order_members(uuid) owner to auth_profile_lookup;
alter function record_order_declaration(uuid, integer, inet, text) owner to auth_profile_lookup;
revoke all on function cancel_client_order(uuid) from public;
revoke all on function client_order_members(uuid) from public;
revoke all on function record_order_declaration(uuid, integer, inet, text) from public;
grant execute on function cancel_client_order(uuid) to app_runtime;
grant execute on function client_order_members(uuid) to app_runtime;
grant execute on function record_order_declaration(uuid, integer, inet, text) to app_runtime;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant update (state_reason, lease_until) on public.dossier_orders to auth_profile_lookup;
grant update (status) on public.dossiers to auth_profile_lookup;
grant select (holder_id) on public.consultations to auth_profile_lookup;

-- Só o cancelamento: dossiê do Bureau da sessão para 'cancelled'; consulta aguardando autorização para 'rejected'.
create policy dossiers_gateway_client_cancel on dossiers for update to auth_profile_lookup
  using (bureau_id = app_bureau_id())
  with check (bureau_id = app_bureau_id() and status = 'cancelled');
create policy consultations_gateway_client_cancel on consultations for update to auth_profile_lookup
  using (bureau_id = app_bureau_id() and status = 'pending_authorization')
  with check (bureau_id = app_bureau_id() and status = 'rejected');
create policy timeline_events_order_cancelled_gateway_insert on timeline_events for insert to auth_profile_lookup
  with check (
    entity_type = 'holder' and event_type = 'order.cancelled' and title = 'Pedido de pesquisa cancelado'
    and bureau_id = app_bureau_id() and created_by = app_user_id()
    and exists (select 1 from holders h where h.id = timeline_events.entity_id and h.bureau_id = timeline_events.bureau_id)
  );
-- Auditoria: só estas duas ações, só do cliente dono do pedido, no Bureau da sessão.
create policy audit_logs_client_order_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('order.cancel', 'order.declaration_accepted') and table_name = 'dossier_orders'
  and support_session_id is null
  and bureau_id = app_bureau_id() and user_id = app_user_id()
  and exists (
    select 1 from dossier_orders o
     where o.dossier_id = audit_logs.record_id and o.bureau_id = audit_logs.bureau_id
       and o.client_profile_id = audit_logs.user_id)
);
