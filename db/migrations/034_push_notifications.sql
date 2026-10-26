-- Notificações push do portal do cliente. Push é o terceiro canal da fila de 020 (notifications, claim_notifications,
-- complete_notification): uma linha por inscrição de aparelho, com recipient = id da inscrição (não é segredo).
-- push_subscriptions guarda endpoint e chaves do aparelho: nenhuma role da aplicação lê a tabela. app_runtime registra,
-- remove e confere pelas funções register/remove/push_subscription_active (só o perfil cliente da sessão); app_dispatch
-- (worker) lê endpoint e chaves só com a lease válida e o dono da inscrição igual ao destinatário original.
-- Os 4 eventos nascem em triggers AFTER nas tabelas que já mudam no evento (mesma transação, sem mexer nas funções de
-- negócio). Conta encerrada (is_active falso ou anonimizada) apaga as inscrições: endpoint é dado do aparelho (LGPD).

-- 1) Canal push. Os CHECKs de conteúdo e de destinatário aceitam a linha sem corpo de e-mail/WhatsApp.
alter table notification_templates drop constraint notification_templates_channel_check;
alter table notification_templates add constraint notification_templates_channel_check
  check (channel in ('email', 'whatsapp', 'push'));
alter table notification_templates drop constraint notification_templates_check;
alter table notification_templates add constraint notification_templates_content_check check (
  (channel = 'email' and email_subject is not null and email_html is not null and email_text is not null
    and wa_template_name is null and wa_language is null)
  or (channel = 'whatsapp' and wa_template_name is not null and wa_language is not null
    and email_subject is null and email_html is null and email_text is null)
  or (channel = 'push' and email_subject is null and email_html is null and email_text is null
    and wa_template_name is null and wa_language is null));
alter table notifications drop constraint notifications_channel_check;
alter table notifications add constraint notifications_channel_check check (channel in ('email', 'whatsapp', 'push'));
alter table notifications add constraint notifications_push_recipient_check check (
  recipient is null or channel <> 'push'
  or recipient ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- O texto do aviso mora no código (push-payload.ts); o banco guarda só a chave e o parâmetro url.
insert into notification_templates (key, channel, version, params) values
  ('scr_partner_authorized', 'push', 1, array['url']),
  ('research_released', 'push', 1, array['url']),
  ('commission_received', 'push', 1, array['url']),
  ('commission_available', 'push', 1, array['url']);

-- 2) Inscrições. Uma por aparelho; o endpoint é único (aparelho trocado de conta muda de dono no upsert).
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  profile_id uuid not null,
  endpoint text not null unique check (endpoint ~ '^https://\S+$' and length(endpoint) <= 2048),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bureau_id, profile_id) references profiles (bureau_id, id) on delete cascade
);
create index push_subscriptions_profile_idx on push_subscriptions (profile_id, updated_at desc);

-- 3) Auxiliar interno (sem grant; só as funções de trigger abaixo chamam): uma linha por inscrição ativa do perfil,
-- idempotente por (bureau_id, idempotency_key = p_event_key:<id da inscrição>). Sem template ativo: erro de deploy,
-- desfaz a transação do evento. Devolve quantas linhas são novas.
create function enqueue_push_for_profile(
  p_profile_id uuid,
  p_template_key text,
  p_url text,
  p_event_key text,
  p_reference text
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_tpl public.notification_templates;
  v_count integer;
begin
  select * into v_tpl from public.notification_templates
   where key = p_template_key and channel = 'push' and status = 'active';
  if not found then
    raise exception 'notification template % (push) not found', p_template_key using errcode = 'P0002';
  end if;

  with queued as (
    insert into public.notifications
      (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
       idempotency_key, reference, created_by)
    select s.bureau_id, v_tpl.id, 'push', s.id::text, 'aparelho ' || left(s.id::text, 8),
           public.notification_recipient_hash(s.id::text), jsonb_build_object('url', p_url),
           p_event_key || ':' || s.id::text, p_reference, s.profile_id
      from public.push_subscriptions s
      join public.profiles p on p.id = s.profile_id
     where s.profile_id = p_profile_id and p.role = 'client' and p.is_active and p.anonymized_at is null
    on conflict (bureau_id, idempotency_key) do nothing
    returning id, bureau_id
  ), logged as (
    insert into public.notification_events (notification_id, bureau_id, kind)
    select q.id, q.bureau_id, 'queued' from queued q
    returning 1
  )
  select count(*) into v_count from logged;
  return v_count;
end
$$;

-- Perfil cliente da sessão (ativo, não anonimizado, do Bureau da sessão) ou nulo. Interno, sem grant.
create function push_session_profile()
returns uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select p.id
    from public.profiles p
   where public.app_context_present() and public.app_user_role() = 'client'
     and p.id = public.app_user_id() and p.bureau_id = public.app_bureau_id()
     and p.role = 'client' and p.is_active and p.anonymized_at is null
$$;

-- Registra o aparelho do cliente da sessão. Mesmo endpoint do mesmo perfil: troca chaves e user agent, sem auditoria.
-- Endpoint novo ou de outro perfil: passa a ser do perfil da sessão, com auditoria. Mantém só as 10 mais novas.
create function register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_profile uuid := public.push_session_profile();
  v_owner uuid;
begin
  if v_profile is null then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://\S+$' or length(p_endpoint) > 2048
     or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{80,100}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{16,32}$'
     or length(p_user_agent) > 512 then
    return query select false, 'invalid_input'::text;
    return;
  end if;

  select s.profile_id into v_owner from public.push_subscriptions s where s.endpoint = p_endpoint for update;
  if found and v_owner = v_profile then
    update public.push_subscriptions
       set p256dh = p_p256dh, auth = p_auth, user_agent = p_user_agent, updated_at = clock_timestamp()
     where endpoint = p_endpoint;
  else
    insert into public.push_subscriptions (bureau_id, profile_id, endpoint, p256dh, auth, user_agent, updated_at)
    values (public.app_bureau_id(), v_profile, p_endpoint, p_p256dh, p_auth, p_user_agent, clock_timestamp())
    on conflict (endpoint) do update
      set bureau_id = excluded.bureau_id, profile_id = excluded.profile_id, p256dh = excluded.p256dh,
          auth = excluded.auth, user_agent = excluded.user_agent, updated_at = excluded.updated_at;
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id)
    values (public.app_bureau_id(), v_profile, 'client.push_subscribed', 'profiles', v_profile);
  end if;

  delete from public.push_subscriptions s
   where s.profile_id = v_profile
     and s.id in (select o.id from public.push_subscriptions o where o.profile_id = v_profile
                   order by o.updated_at desc, o.id desc offset 10);
  return query select true, null::text;
end
$$;

-- Remove o aparelho do cliente da sessão. Endpoint alheio ou ausente: ok = true e nada muda (não revela de quem é).
create function remove_push_subscription(p_endpoint text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_profile uuid := public.push_session_profile();
begin
  if v_profile is null then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  delete from public.push_subscriptions s where s.endpoint = p_endpoint and s.profile_id = v_profile;
  if found then
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id)
    values (public.app_bureau_id(), v_profile, 'client.push_unsubscribed', 'profiles', v_profile);
  end if;
  return query select true, null::text;
end
$$;

-- A tela mostra "ligado" só se o servidor confirma que o endpoint do navegador é do perfil da sessão.
create function push_subscription_active(p_endpoint text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.push_subscriptions s
     where s.endpoint = p_endpoint and s.profile_id = public.push_session_profile())
$$;

-- Worker (app_dispatch): endpoint e chaves só com a lease válida e o dono igual ao destinatário original. Inscrição
-- removida ou transferida para outro perfil: nenhuma linha (o aviso de um perfil nunca chega ao aparelho de outro).
create function push_subscription_for_delivery(p_notification_id uuid, p_lease_id uuid)
returns table (endpoint text, p256dh text, auth text)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select s.endpoint, s.p256dh, s.auth
    from public.notifications n
    join public.push_subscriptions s on s.id::text = n.recipient and s.profile_id = n.created_by
   where n.id = p_notification_id and n.lease_id = p_lease_id and n.status = 'sending' and n.channel = 'push'
$$;

-- Worker: o serviço de push recusou o endpoint (404/410). Apaga a inscrição com as mesmas condições de lease e dono.
create function delete_gone_push_subscription(p_notification_id uuid, p_lease_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.push_subscriptions s
   using public.notifications n
   where n.id = p_notification_id and n.lease_id = p_lease_id and n.status = 'sending' and n.channel = 'push'
     and s.id::text = n.recipient and s.profile_id = n.created_by;
  return found;
end
$$;

-- 5) Triggers dos eventos. Funções SECURITY DEFINER (dono auth_profile_lookup); retorno ignorado (AFTER ROW).

-- Evento 1: sócio autorizou o SCR. Sem aviso quando o sócio é o próprio comprador (ele acabou de autorizar).
create function push_on_scr_authorized()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_dossier uuid;
begin
  if exists (select 1 from public.profiles p
              where p.id = new.client_profile_id and lower(p.email) = lower(new.email)) then
    return null;
  end if;
  select c.dossier_id into v_dossier
    from public.consultations c
   where c.scr_authorization_id = new.id and c.dossier_id is not null
   order by c.created_at desc
   limit 1;
  perform public.enqueue_push_for_profile(
    new.client_profile_id, 'scr_partner_authorized',
    case when v_dossier is null then '/portal/pesquisas' else '/portal/pesquisas/' || v_dossier end,
    'scr_partner_authorized:' || new.id,
    case when v_dossier is null then 'scr:' || new.id else 'order:' || v_dossier end);
  return null;
end
$$;

-- Evento 2: consulta pronta. O novo released_at separa a liberação nova (depois de revogar) da repetição.
create function push_on_order_released()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.enqueue_push_for_profile(
    new.client_profile_id, 'research_released', '/portal/pesquisas/' || new.dossier_id,
    'research_released:push:' || new.dossier_id || ':' || floor(extract(epoch from new.released_at) * 1000)::bigint,
    'order:' || new.dossier_id);
  return null;
end
$$;

-- Evento 3: comissão recebida (uma por comissão).
create function push_on_commission_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.enqueue_push_for_profile(
    new.affiliate_profile_id, 'commission_received', '/portal/afiliacao',
    'commission_received:' || new.id, 'commission:' || new.id);
  return null;
end
$$;

-- Evento 4: comissão disponível para saque. Um aviso por afiliado e por transação (uma execução de
-- release_due_commissions), não um por comissão.
create function push_on_commission_released()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.enqueue_push_for_profile(
    new.affiliate_profile_id, 'commission_available', '/portal/afiliacao',
    'commission_available:' || new.affiliate_profile_id || ':' || pg_current_xact_id()::text,
    'affiliate:' || new.affiliate_profile_id);
  return null;
end
$$;

-- Conta encerrada: apaga as inscrições do perfil.
create function push_drop_on_profile_closed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.push_subscriptions where profile_id = new.id;
  return null;
end
$$;

create trigger scr_authorizations_push after update of status on scr_authorizations for each row
  when (new.status = 'authorized' and old.status is distinct from new.status
        and new.client_profile_id is not null and new.channel = 'internal')
  execute function push_on_scr_authorized();
create trigger dossier_orders_push after update of state, released_at on dossier_orders for each row
  when (new.state = 'released' and new.client_profile_id is not null
        and new.released_at is distinct from old.released_at)
  execute function push_on_order_released();
create trigger affiliate_commissions_push_created after insert on affiliate_commissions for each row
  execute function push_on_commission_created();
create trigger affiliate_commissions_push_released after update of status on affiliate_commissions for each row
  when (old.status = 'pending' and new.status = 'released')
  execute function push_on_commission_released();
create trigger profiles_drop_push_subscriptions after update of is_active, anonymized_at on profiles for each row
  when (new.anonymized_at is not null or not new.is_active)
  execute function push_drop_on_profile_closed();

-- 6) Acesso. Tabela: só o dono das funções (auth_profile_lookup) sob as políticas abaixo; a aplicação não tem grant.
alter table push_subscriptions owner to schema_owner;
alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
revoke all on push_subscriptions from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
grant select on push_subscriptions to backup_reader;
grant select, insert, delete, update (bureau_id, profile_id, p256dh, auth, user_agent, updated_at)
  on push_subscriptions to auth_profile_lookup;
create policy push_subscriptions_gateway_select on push_subscriptions for select to auth_profile_lookup using (true);
create policy push_subscriptions_gateway_insert on push_subscriptions for insert to auth_profile_lookup with check (true);
create policy push_subscriptions_gateway_update on push_subscriptions for update to auth_profile_lookup
  using (true) with check (true);
create policy push_subscriptions_gateway_delete on push_subscriptions for delete to auth_profile_lookup using (true);
create policy audit_logs_client_push_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('client.push_subscribed', 'client.push_unsubscribed')
  and table_name = 'profiles' and record_id = user_id and support_session_id is null
  and exists (select 1 from profiles p
               where p.id = audit_logs.user_id and p.role = 'client' and p.bureau_id = audit_logs.bureau_id));

alter function enqueue_push_for_profile(uuid, text, text, text, text) owner to auth_profile_lookup;
alter function push_session_profile() owner to auth_profile_lookup;
alter function register_push_subscription(text, text, text, text) owner to auth_profile_lookup;
alter function remove_push_subscription(text) owner to auth_profile_lookup;
alter function push_subscription_active(text) owner to auth_profile_lookup;
alter function push_subscription_for_delivery(uuid, uuid) owner to auth_profile_lookup;
alter function delete_gone_push_subscription(uuid, uuid) owner to auth_profile_lookup;
alter function push_on_scr_authorized() owner to auth_profile_lookup;
alter function push_on_order_released() owner to auth_profile_lookup;
alter function push_on_commission_created() owner to auth_profile_lookup;
alter function push_on_commission_released() owner to auth_profile_lookup;
alter function push_drop_on_profile_closed() owner to auth_profile_lookup;

revoke all on function enqueue_push_for_profile(uuid, text, text, text, text) from public;
revoke all on function push_session_profile() from public;
revoke all on function register_push_subscription(text, text, text, text) from public;
revoke all on function remove_push_subscription(text) from public;
revoke all on function push_subscription_active(text) from public;
revoke all on function push_subscription_for_delivery(uuid, uuid) from public;
revoke all on function delete_gone_push_subscription(uuid, uuid) from public;
revoke all on function push_on_scr_authorized() from public;
revoke all on function push_on_order_released() from public;
revoke all on function push_on_commission_created() from public;
revoke all on function push_on_commission_released() from public;
revoke all on function push_drop_on_profile_closed() from public;

grant execute on function register_push_subscription(text, text, text, text), remove_push_subscription(text),
  push_subscription_active(text) to app_runtime;
grant execute on function push_subscription_for_delivery(uuid, uuid), delete_gone_push_subscription(uuid, uuid)
  to app_dispatch;
