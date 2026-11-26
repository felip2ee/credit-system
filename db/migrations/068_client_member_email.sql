-- O cliente corrige ou reenvia o e-mail de quem autoriza o SCR no próprio pedido.
-- 1) client_order_members (025) passa a devolver o id da consulta, o e-mail mascarado e as flags de ação.
-- 2) update_my_order_member_email troca o e-mail do membro (ou só reenvia, com e-mail nulo): mesmo mecanismo de
--    update_order_contact (044), mas só para o dono do pedido e só em autorização pendente no prazo. Gira o public_token,
--    apaga o auth_code, renova o prazo e anula o e-mail ainda na fila. A função não envia: o tick de pedidos emite o
--    link novo porque a autorização fica pendente sem auth_code.
-- O cliente não tem política em scr_authorizations: a posse do pedido é conferida em SQL, na mesma consulta de trava.
-- supersede_notifications (020) devolve 0 para o papel client e não serve aqui: a anulação é feita na própria função,
-- limitada à referência desta autorização e ao Bureau da sessão.

create function client_member_change_limit() returns integer
language sql immutable set search_path = pg_catalog, public as $$ select 3 $$;

drop function client_order_members(uuid);
create function client_order_members(p_dossier_id uuid)
returns table (
  consultation_id uuid, role text, name text, document_masked text, email_masked text, scr_status text,
  can_edit_email boolean, can_resend boolean, changes_left integer)
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
    select m.consultation_id, m.role, m.name, m.document_masked, m.email_masked, m.scr_status,
           (m.pending_open and m.order_state in ('awaiting_payment', 'awaiting_authorization')
              and m.left_today > 0 and not m.is_own),
           (m.pending_open and m.order_state = 'awaiting_authorization' and m.left_today > 0 and m.has_email),
           m.left_today
      from (
        select
          c.id as consultation_id,
          (case when c.holder_id = d.holder_id
                then case when o.product_code = 'dossie_empresarial' then 'company' else 'subject' end
                else 'partner' end)::text as role,
          c.document_name::text as name,
          coalesce(public.order_mask_document(h.document_digits), '—')::text as document_masked,
          (case when coalesce(s.email, c.scr_email) is null then null
                else public.account_mask_recipient('email', lower(coalesce(s.email, c.scr_email))) end)::text as email_masked,
          (case
             when s.id is null then 'pending'
             when s.status = 'not_authorized' then 'refused'
             when s.status = 'expired' then 'expired'
             when s.status = 'authorized' then
               case when s.expires_at is not null and s.expires_at <= now() then 'expired' else 'authorized' end
             when coalesce(s.request_expires_at, s.expires_at) <= now() then 'expired'
             else 'pending'
           end)::text as scr_status,
          (s.id is not null and s.status = 'pending' and c.status::text = 'pending_authorization'
             and (s.request_expires_at is null or s.request_expires_at > now())) as pending_open,
          o.state::text as order_state,
          (s.email is not null) as has_email,
          (h.client_profile_id is not distinct from public.app_user_id()) as is_own,
          greatest(public.client_member_change_limit() - coalesce((
            select count(*) from unnest(s.contact_changes_at) t where t > now() - interval '24 hours'), 0), 0)::integer
            as left_today
        from public.dossier_orders o
        join public.dossiers d on d.id = o.dossier_id
        join public.consultations c on c.dossier_id = o.dossier_id and c.bureau_id = o.bureau_id
        join public.holders h on h.id = c.holder_id
        left join public.scr_authorizations s on s.id = c.scr_authorization_id
       where o.dossier_id = p_dossier_id
         and o.bureau_id = public.app_bureau_id()
         and o.client_profile_id = public.app_user_id()
      ) m
     order by (m.role not in ('company', 'subject')), m.name, m.consultation_id;
end
$$;

alter function client_order_members(uuid) owner to auth_profile_lookup;
revoke all on function client_order_members(uuid) from public;
grant execute on function client_order_members(uuid) to app_runtime;

create function update_my_order_member_email(p_dossier_id uuid, p_consultation_id uuid, p_email text)
returns table (ok boolean, reason text, authorization_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  c_email_re constant text := '^[^\s@,;()<>"]+@[^\s@,;()<>"]+\.[^\s@,;()<>"]+$';
  c_cooldown constant interval := interval '2 minutes';
  c_max_recent_requests constant integer := 3;
  c_request_ttl constant interval := interval '7 days';  -- igual a SCR_REQUEST_DAYS
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_order record;
  v_member record;
  v_buyer_email text;
  v_is_own boolean;
  v_changes timestamptz[];
  v_recent integer;
  v_shared integer;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null
     or public.app_user_role() is distinct from 'client' or p_dossier_id is null or p_consultation_id is null then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  if p_email is not null and (v_email is null or length(v_email) > 254 or v_email !~ c_email_re) then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- Posse do pedido na própria consulta de trava. Ordem de trava de 044: pedido, depois autorização.
  select o.state into v_order from public.dossier_orders o
   where o.dossier_id = p_dossier_id and o.bureau_id = v_bureau and o.client_profile_id = v_user
     for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  if v_order.state not in ('awaiting_payment', 'awaiting_authorization') then
    return query select false, 'invalid_state'::text, null::uuid;
    return;
  end if;

  select c.status::text as consultation_status, s.id as auth_id, s.status::text as auth_status, s.document,
         s.email, s.request_expires_at, s.contact_changes_at into v_member
    from public.consultations c
    join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.id = p_consultation_id and c.dossier_id = p_dossier_id and c.bureau_id = v_bureau
     and s.bureau_id = v_bureau and s.channel = 'internal'
     for update of s;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  if v_member.consultation_status <> 'pending_authorization' or v_member.auth_status <> 'pending'
     or (v_member.request_expires_at is not null and v_member.request_expires_at <= now()) then
    return query select false, 'invalid_state'::text, null::uuid;
    return;
  end if;

  if v_email is null then  -- reenviar
    if v_order.state = 'awaiting_payment' or v_member.email is null then
      return query select false, 'invalid_state'::text, null::uuid;
      return;
    end if;
  else                     -- corrigir
    v_is_own := exists (select 1 from public.holders h
                         where h.bureau_id = v_bureau and h.client_profile_id = v_user
                           and h.document_digits = v_member.document);
    if v_is_own then
      return query select false, 'own_account_email'::text, null::uuid;
      return;
    end if;
    if v_email = lower(v_member.email) then
      return query select false, 'same_email'::text, null::uuid;
      return;
    end if;
    select lower(p.email) into v_buyer_email from public.profiles p where p.id = v_user and p.bureau_id = v_bureau;
    if v_email = v_buyer_email then
      return query select false, 'contact_is_buyer'::text, null::uuid;
      return;
    end if;
  end if;

  v_changes := array(select t from unnest(v_member.contact_changes_at) t where t > now() - interval '24 hours');
  if exists (select 1 from unnest(v_changes) t where t > now() - c_cooldown) then
    return query select false, 'resend_too_soon'::text, null::uuid;
    return;
  end if;
  if cardinality(v_changes) >= public.client_member_change_limit() then
    return query select false, 'resend_limit_reached'::text, null::uuid;
    return;
  end if;

  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || v_email, 0));
    select count(*) into v_recent from public.scr_authorizations s
     where s.bureau_id = v_bureau and s.id <> v_member.auth_id and s.status = 'pending'
       and s.requested_at > now() - interval '24 hours' and lower(s.email) = v_email;
    if v_recent >= c_max_recent_requests then
      return query select false, 'too_many_requests'::text, null::uuid;
      return;
    end if;
  end if;

  update public.scr_authorizations
     set email = coalesce(v_email, email), public_token = gen_random_uuid(), auth_code = null,
         request_expires_at = case when v_order.state = 'awaiting_authorization' then now() + c_request_ttl
                                   else request_expires_at end,
         last_checked_at = now(), contact_changes_at = v_changes || now()
   where id = v_member.auth_id;
  update public.consultations set scr_email = coalesce(v_email, scr_email)
   where scr_authorization_id = v_member.auth_id and status = 'pending_authorization';

  -- E-mail ainda na fila: traria o código e o link que acabaram de ser invalidados.
  with moved as (
    update public.notifications n
       set status = 'suppressed', recipient = null, params = null, last_error_code = 'superseded', updated_at = now()
      from public.notification_templates t
     where t.id = n.template_id and t.key = 'scr_authorization'
       and n.reference = 'scr_authorization:' || v_member.auth_id::text and n.bureau_id = v_bureau
       and n.status in ('pending', 'failed')
    returning n.id, n.bureau_id
  )
  insert into public.notification_events (notification_id, bureau_id, kind, error_code)
  select m.id, m.bureau_id, 'suppressed', 'superseded' from moved m;

  select count(distinct c.dossier_id) into v_shared
    from public.consultations c join public.dossier_orders o on o.dossier_id = c.dossier_id and o.bureau_id = v_bureau
   where c.bureau_id = v_bureau and c.scr_authorization_id = v_member.auth_id
     and c.status = 'pending_authorization' and o.state in ('awaiting_payment', 'awaiting_authorization');
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user,
          case when v_email is null then 'order.member_resend' else 'order.member_email_update' end,
          'dossier_orders', p_dossier_id,
          jsonb_build_object('consultation_id', p_consultation_id, 'authorization_id', v_member.auth_id,
            'previous_email_masked', case when v_member.email is null then null
                                          else public.account_mask_recipient('email', lower(v_member.email)) end,
            'email_masked', public.account_mask_recipient('email', coalesce(v_email, lower(v_member.email))),
            'shared_dossiers', v_shared));
  return query select true, null::text, v_member.auth_id;
end
$$;

alter function update_my_order_member_email(uuid, uuid, text) owner to auth_profile_lookup;
revoke all on function update_my_order_member_email(uuid, uuid, text) from public;
grant execute on function update_my_order_member_email(uuid, uuid, text) to app_runtime;
-- Novo: 044 não precisava gravar o prazo, e ler scr_email só era preciso para gravá-lo.
grant update (request_expires_at) on public.scr_authorizations to auth_profile_lookup;
grant select (scr_email) on public.consultations to auth_profile_lookup;

create policy audit_logs_client_member_email_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('order.member_email_update', 'order.member_resend') and table_name = 'dossier_orders'
  and support_session_id is null and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and user_id = app_user_id()
  and exists (select 1 from dossier_orders o
               where o.dossier_id = audit_logs.record_id and o.bureau_id = audit_logs.bureau_id
                 and o.client_profile_id = app_user_id()));
