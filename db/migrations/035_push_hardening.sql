-- Endurecimento do push (034 já aplicada; não editar). Duas mudanças:
-- 1) O host do endpoint tem só [A-Za-z0-9.-] antes da primeira "/": defesa em profundidade contra parsers que leem o
--    host diferente (a lista de hosts do app é a barreira principal). Linhas existentes passaram pela lista de hosts.
-- 2) Os gatilhos dos eventos não derrubam a operação de origem: um erro ao enfileirar o aviso (template ausente,
--    falha de insert) vira warning e a transação de dinheiro/autorização segue. O aviso é só um complemento.

-- 1) Endpoint
alter table push_subscriptions drop constraint if exists push_subscriptions_endpoint_host_check;
alter table push_subscriptions add constraint push_subscriptions_endpoint_host_check
  check (endpoint ~ '^https://[A-Za-z0-9.-]+(/\S*)?$');

create or replace function register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
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
  if p_endpoint is null or p_endpoint !~ '^https://[A-Za-z0-9.-]+(/\S*)?$' or length(p_endpoint) > 2048
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

-- 2) Gatilhos: o enfileiramento fica num bloco com exception. Dono, search_path e grants seguem os de 034
-- (create or replace mantém dono e privilégios). O warning leva só a chave do template e o SQLSTATE: sem dado pessoal.
create or replace function push_on_scr_authorized()
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
  begin
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
  exception when others then
    raise warning 'push enqueue failed (scr_partner_authorized): sqlstate %', sqlstate;
  end;
  return null;
end
$$;

create or replace function push_on_order_released()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    perform public.enqueue_push_for_profile(
      new.client_profile_id, 'research_released', '/portal/pesquisas/' || new.dossier_id,
      'research_released:push:' || new.dossier_id || ':' || floor(extract(epoch from new.released_at) * 1000)::bigint,
      'order:' || new.dossier_id);
  exception when others then
    raise warning 'push enqueue failed (research_released): sqlstate %', sqlstate;
  end;
  return null;
end
$$;

create or replace function push_on_commission_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    perform public.enqueue_push_for_profile(
      new.affiliate_profile_id, 'commission_received', '/portal/afiliacao',
      'commission_received:' || new.id, 'commission:' || new.id);
  exception when others then
    raise warning 'push enqueue failed (commission_received): sqlstate %', sqlstate;
  end;
  return null;
end
$$;

create or replace function push_on_commission_released()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    perform public.enqueue_push_for_profile(
      new.affiliate_profile_id, 'commission_available', '/portal/afiliacao',
      'commission_available:' || new.affiliate_profile_id || ':' || pg_current_xact_id()::text,
      'affiliate:' || new.affiliate_profile_id);
  exception when others then
    raise warning 'push enqueue failed (commission_available): sqlstate %', sqlstate;
  end;
  return null;
end
$$;
