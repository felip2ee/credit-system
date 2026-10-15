-- M4: notificações (e-mail e WhatsApp). A 001-019 já foram aplicadas e não mudam.
-- Fila (outbox) em Postgres: notification_templates (versionados, imutáveis), notifications (fila + estado),
-- notification_events (log só de acréscimo) e notification_opt_outs (sem grant para a aplicação).
-- Toda escrita passa por função SECURITY DEFINER com dono auth_profile_lookup (NOBYPASSRLS, sob as políticas
-- *_gateway abaixo). app_runtime enfileira (enqueue_notification) e pede nova tentativa (retry_notification).
-- app_webhook, sem grant de tabela, pega o lote, conclui, aplica status da Meta e grava opt-out.
-- recipient e params (dado pessoal) somem no estado final; só recipient_masked e recipient_hash ficam.

create table notification_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  channel text not null check (channel in ('email', 'whatsapp')),
  version integer not null check (version > 0),
  status text not null default 'active' check (status in ('active', 'retired')),
  -- Ordem = ordem dos parâmetros do corpo do template da Meta ({{1}}, {{2}}, ...).
  params text[] not null default '{}',
  email_subject text,
  email_html text,
  email_text text,
  -- A Meta aceita até 512; o regex do Postgres limita a repetição a 255.
  wa_template_name text check (wa_template_name ~ '^[a-z0-9_]{1,255}$'),
  wa_language text check (wa_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  created_at timestamptz not null default now(),
  unique (key, channel, version),
  check (
    (channel = 'email' and email_subject is not null and email_html is not null and email_text is not null
      and wa_template_name is null and wa_language is null)
    or (channel = 'whatsapp' and wa_template_name is not null and wa_language is not null
      and email_subject is null and email_html is null and email_text is null)
  )
);
create unique index notification_templates_one_active on notification_templates (key, channel) where status = 'active';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid references bureaus(id),            -- nulo: teste do superadmin
  template_id uuid not null references notification_templates(id),
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient text,                                    -- apagado no estado final
  recipient_masked text not null check (length(recipient_masked) between 1 and 100),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  params jsonb,                                      -- apagado com recipient
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  reference text check (reference is null or length(reference) <= 200),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  locked_until timestamptz,
  provider_message_id text unique,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 64),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (bureau_id, idempotency_key),
  check (recipient is null or channel <> 'whatsapp' or recipient ~ '^\+[1-9][0-9]{7,14}$'),
  check (recipient is null or channel <> 'email' or recipient ~ '^[^@\s]+@[^@\s]+$'),
  check ((status = 'sending') = (lease_id is not null and locked_until is not null)),
  check (status not in ('pending', 'sending') or (recipient is not null and params is not null))
);
create index notifications_pending_due on notifications (next_attempt_at) where status = 'pending';
create index notifications_sending_lease on notifications (locked_until) where status = 'sending';
create index notifications_bureau_created on notifications (bureau_id, created_at desc, id desc);
create index notifications_reference on notifications (reference, created_at desc) where reference is not null;

create table notification_events (
  id bigint generated always as identity primary key,
  notification_id uuid references notifications(id),   -- nulo: status da Meta antes do id (órfão)
  bureau_id uuid references bureaus(id),
  kind text not null
    check (kind in ('queued', 'attempt_failed', 'sent', 'delivered', 'read', 'failed', 'suppressed', 'retried')),
  error_code text check (error_code is null or length(error_code) <= 64),
  provider_message_id text,
  dedupe_key text unique,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index notification_events_notification on notification_events (notification_id, id);
create index notification_events_orphan on notification_events (provider_message_id) where notification_id is null;

create table notification_opt_outs (
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('whatsapp_keyword')),
  created_at timestamptz not null default now(),
  primary key (channel, recipient_hash)
);

-- Único ponto que calcula o hash do destinatário (fila, opt-out e checagem de opt-out no claim).
create function notification_recipient_hash(p text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Guardas. Template: só active -> retired. Evento: só a adoção de órfão. Nenhum DELETE.
create function notifications_no_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% does not accept DELETE', tg_table_name using errcode = 'check_violation';
end
$$;

create function notification_templates_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_expected public.notification_templates := old;
begin
  v_expected.status := 'retired';
  if old.status = 'active' and new.status = 'retired' and new is not distinct from v_expected then
    return new;
  end if;
  raise exception 'notification_templates only accepts active -> retired' using errcode = 'check_violation';
end
$$;

create function notification_events_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_expected public.notification_events := old;
begin
  v_expected.notification_id := new.notification_id;
  v_expected.bureau_id := new.bureau_id;
  if old.notification_id is null and old.bureau_id is null and new.notification_id is not null
     and new is not distinct from v_expected then
    return new;
  end if;
  raise exception 'notification_events only accepts the adoption of an orphan event' using errcode = 'check_violation';
end
$$;

create trigger notification_templates_guard before update on notification_templates
  for each row execute function notification_templates_guard();
create trigger notification_templates_no_delete before delete on notification_templates
  for each row execute function notifications_no_delete();
create trigger notification_events_guard before update on notification_events
  for each row execute function notification_events_guard();
create trigger notification_events_no_delete before delete on notification_events
  for each row execute function notifications_no_delete();
create trigger notifications_no_delete before delete on notifications
  for each row execute function notifications_no_delete();

-- Sementes. Os marcadores {{nome}} são trocados pelo renderizador; o HTML e o texto vêm de
-- buildScrAuthorizationEmail (src/lib/email/scr-authorization-email.ts) sem mudança de cor, texto ou estrutura.
insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
values (
  'scr_authorization', 'email', 1, array['clientName', 'authorizedName', 'code', 'url'],
  $tpl$Autorização de consulta SCR — Rainha do Crédito$tpl$,
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
            <div style="font-size:17px;font-weight:700;">Autorização de consulta SCR</div>
          </td></tr>
          <tr><td style="padding:26px 24px;text-align:center;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 8px;">Olá {{clientName}},</p>
            <p style="margin:0 0 22px;">A {{authorizedName}} gostaria de realizar a consulta SCR dos seus dados. Use o código abaixo para autorizar.</p>
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Seu código de confirmação:</p>
            <div style="margin:0 auto 8px;max-width:280px;border:2px dashed #0E8C84;border-radius:8px;background:#f4faf9;padding:16px 12px;font-family:'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#0B5F59;">{{code}}</div>
            <p style="margin:0 0 22px;font-size:11px;color:#6b7280;">Toque e segure (ou selecione) o código para copiar.</p>
            <a href="{{url}}" style="display:inline-block;background:#C9A24B;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px;padding:14px 28px;border-radius:6px;">AUTORIZAR CONSULTA</a>
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
  $tpl$Olá {{clientName}},

A {{authorizedName}} gostaria de realizar a consulta SCR dos seus dados.
Seu código de confirmação: {{code}}

Autorize em: {{url}}

Eliane Moreira — Rainha do Crédito
(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito$tpl$
);
insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
values (
  'platform_test', 'email', 1, '{}',
  'Teste de envio — Plataforma Bureau',
  '<!doctype html><html lang="pt-BR"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;"><p>Este é um e-mail de teste da Plataforma Bureau. Nenhuma ação é necessária.</p></body></html>',
  'Este é um e-mail de teste da Plataforma Bureau. Nenhuma ação é necessária.'
);
insert into notification_templates (key, channel, version, params, wa_template_name, wa_language)
values ('platform_test', 'whatsapp', 1, '{}', 'hello_world', 'en_US');

-- Enfileira. Quem pode: bureau_admin e operator (Bureau da sessão); superadmin em suporte (Bureau da sessão de suporte);
-- superadmin sem suporte (Bureau nulo, teste). client e contexto ausente: not_allowed.
-- Os testes de formato repetem as CHECKs da tabela para devolver um motivo em vez de levantar erro.
create function enqueue_notification(
  p_template_key text,
  p_channel text,
  p_recipient text,
  p_recipient_masked text,
  p_params jsonb,
  p_idempotency_key text,
  p_reference text
)
returns table (ok boolean, reason text, notification_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_role text := public.app_user_role();
  v_bureau uuid;
  v_tpl public.notification_templates;
  v_id uuid;
begin
  if not public.app_context_present() then
    return query select false, 'not_allowed'::text, null::uuid, false;
    return;
  end if;
  if v_role in ('bureau_admin', 'operator') then
    v_bureau := public.app_bureau_id();
    if v_bureau is null then
      return query select false, 'not_allowed'::text, null::uuid, false;
      return;
    end if;
  elsif v_role = 'superadmin' then
    if public.app_support_active() then
      v_bureau := public.app_bureau_id();
    elsif public.app_support_session_id() is not null then
      return query select false, 'not_allowed'::text, null::uuid, false;
      return;
    end if;
  else
    return query select false, 'not_allowed'::text, null::uuid, false;
    return;
  end if;

  select * into v_tpl from public.notification_templates
   where key = p_template_key and channel = p_channel and status = 'active';
  if not found then
    return query select false, 'template_not_found'::text, null::uuid, false;
    return;
  end if;

  if p_params is null or jsonb_typeof(p_params) <> 'object'
     or exists (select 1 from jsonb_each(p_params) e where jsonb_typeof(e.value) <> 'string')
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_params) k)
        <> (select coalesce(array_agg(x order by x), '{}') from unnest(v_tpl.params) x) then
    return query select false, 'invalid_params'::text, null::uuid, false;
    return;
  end if;

  if p_recipient is null
     or (p_channel = 'whatsapp' and p_recipient !~ '^\+[1-9][0-9]{7,14}$')
     or (p_channel = 'email' and p_recipient !~ '^[^@\s]+@[^@\s]+$') then
    return query select false, 'invalid_recipient'::text, null::uuid, false;
    return;
  end if;
  if p_recipient_masked is null or length(p_recipient_masked) not between 1 and 100
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 200
     or length(p_reference) > 200 then
    return query select false, 'invalid_input'::text, null::uuid, false;
    return;
  end if;

  insert into public.notifications
    (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
     idempotency_key, reference, created_by)
  values
    (v_bureau, v_tpl.id, p_channel, p_recipient, p_recipient_masked,
     public.notification_recipient_hash(p_recipient), p_params, p_idempotency_key, p_reference,
     public.app_user_id())
  on conflict (bureau_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select n.id into v_id from public.notifications n
     where n.bureau_id is not distinct from v_bureau and n.idempotency_key = p_idempotency_key;
    return query select true, null::text, v_id, true;
    return;
  end if;

  insert into public.notification_events (notification_id, bureau_id, kind)
  values (v_id, v_bureau, 'queued');
  return query select true, null::text, v_id, false;
end
$$;

-- Reemissão: move as notificações pending/failed mais antigas, do mesmo Bureau, template e reference, para
-- suppressed (apaga recipient e params). Quem já está sending/sent/delivered/read não muda. Devolve quantas moveu.
-- Mesma regra de Bureau do enqueue_notification.
create function supersede_notifications(p_template_key text, p_reference text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := public.app_user_role();
  v_bureau uuid;
  v_count integer;
begin
  if not public.app_context_present() or p_template_key is null or p_reference is null then
    return 0;
  end if;
  if v_role in ('bureau_admin', 'operator') then
    v_bureau := public.app_bureau_id();
    if v_bureau is null then
      return 0;
    end if;
  elsif v_role = 'superadmin' then
    if public.app_support_active() then
      v_bureau := public.app_bureau_id();
    elsif public.app_support_session_id() is not null then
      return 0;
    end if;
  else
    return 0;
  end if;

  with moved as (
    update public.notifications n
       set status = 'suppressed', recipient = null, params = null, last_error_code = 'superseded', updated_at = now()
      from public.notification_templates t
     where t.id = n.template_id and t.key = p_template_key
       and n.reference = p_reference and n.bureau_id is not distinct from v_bureau
       and n.status in ('pending', 'failed')
    returning n.id, n.bureau_id
  ), logged as (
    insert into public.notification_events (notification_id, bureau_id, kind, error_code)
    select m.id, m.bureau_id, 'suppressed', 'superseded' from moved m
    returning 1
  )
  select count(*) into v_count from logged;
  return v_count;
end
$$;

-- Pega o lote do worker (app_webhook). Cada linha volta com o template já resolvido.
create function claim_notifications(p_limit integer)
returns table (
  id uuid, lease_id uuid, channel text, recipient text, params jsonb, attempts integer, opted_out boolean,
  template_key text, template_version integer, template_params text[],
  email_subject text, email_html text, email_text text, wa_template_name text, wa_language text
)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
begin
  -- Lease vencida sem tentativa sobrando: falha final (o processo caiu na última tentativa).
  with expired as (
    update public.notifications n
       set status = 'failed', last_error_code = 'lease_expired', lease_id = null, locked_until = null, updated_at = now()
     where n.status = 'sending' and n.locked_until < now() and n.attempts >= n.max_attempts
    returning n.id, n.bureau_id
  )
  insert into public.notification_events (notification_id, bureau_id, kind, error_code)
  select e.id, e.bureau_id, 'failed', 'lease_expired' from expired e;

  -- Retenção: failed guarda destinatário e parâmetros por 7 dias para a nova tentativa manual.
  update public.notifications n
     set recipient = null, params = null
   where n.status = 'failed' and n.recipient is not null and n.updated_at < now() - interval '7 days';

  return query
  with picked as (
    select n.id
      from public.notifications n
     where (n.status = 'pending' and n.next_attempt_at <= now())
        or (n.status = 'sending' and n.locked_until < now() and n.attempts < n.max_attempts)
     order by n.next_attempt_at
     limit least(greatest(coalesce(p_limit, 1), 1), 50)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set status = 'sending', lease_id = gen_random_uuid(), locked_until = now() + interval '2 minutes',
           attempts = n.attempts + 1, updated_at = now()
      from picked
     where n.id = picked.id
    returning n.id, n.lease_id, n.channel, n.recipient, n.params, n.attempts, n.template_id, n.recipient_hash
  )
  select c.id, c.lease_id, c.channel, c.recipient, c.params, c.attempts,
         exists (select 1 from public.notification_opt_outs o
                  where o.channel = c.channel and o.recipient_hash = c.recipient_hash),
         t.key, t.version, t.params, t.email_subject, t.email_html, t.email_text, t.wa_template_name, t.wa_language
    from claimed c
    join public.notification_templates t on t.id = c.template_id;
end;
$$;

-- StatusOnlyAdvances (interna, só as funções abaixo chamam): sent < delivered < read; failed só sobre sent.
-- Status aplicado apaga recipient e params. Devolve se aplicou.
create function notification_advance_status(p_id uuid, p_status text, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.notifications n
     set status = p_status, recipient = null, params = null,
         last_error_code = case when p_status = 'failed' then coalesce(left(p_error_code, 64), n.last_error_code)
                                else n.last_error_code end,
         updated_at = now()
   where n.id = p_id
     and ((p_status = 'delivered' and n.status = 'sent')
       or (p_status = 'read' and n.status in ('sent', 'delivered'))
       or (p_status = 'failed' and n.status = 'sent'));
  return found;
end
$$;

-- Resultado da tentativa (app_webhook). Só vale para a lease que o worker recebeu no claim.
-- p_outcome: sent | retry | failed | suppressed.
create function complete_notification(
  p_notification_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_n public.notifications;
  v_error text := left(p_error_code, 64);
  v_rank integer;
  v_orphan_failed public.notification_events;
begin
  if p_outcome is null or p_outcome not in ('sent', 'retry', 'failed', 'suppressed') then
    raise exception 'invalid notification outcome: %', p_outcome using errcode = 'invalid_parameter_value';
  end if;
  if p_outcome = 'sent' then
    if p_provider_message_id is null or btrim(p_provider_message_id) = '' then
      raise exception 'provider_message_id is required for outcome sent' using errcode = 'invalid_parameter_value';
    end if;
    -- Mesma trava de apply_whatsapp_status: o status da Meta não escapa da adoção de órfãos.
    perform pg_advisory_xact_lock(hashtext('notification-provider:' || p_provider_message_id));
  end if;

  select * into v_n from public.notifications n
   where n.id = p_notification_id and n.lease_id = p_lease_id and n.status = 'sending'
   for update;
  if not found then
    return 'stale';
  end if;

  if p_outcome = 'sent' then
    update public.notifications n
       set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
           recipient = null, params = null, lease_id = null, locked_until = null,
           last_error_code = null, updated_at = now()
     where n.id = v_n.id;
    insert into public.notification_events (notification_id, bureau_id, kind, provider_message_id)
    values (v_n.id, v_n.bureau_id, 'sent', p_provider_message_id);

    update public.notification_events e
       set notification_id = v_n.id, bureau_id = v_n.bureau_id
     where e.notification_id is null and e.provider_message_id = p_provider_message_id;
    select max(case e.kind when 'read' then 3 else 2 end) into v_rank
      from public.notification_events e
     where e.notification_id = v_n.id and e.provider_message_id = p_provider_message_id
       and e.kind in ('delivered', 'read');
    if v_rank is not null then
      perform public.notification_advance_status(v_n.id, case v_rank when 3 then 'read' else 'delivered' end, null);
    else
      select * into v_orphan_failed from public.notification_events e
       where e.notification_id = v_n.id and e.provider_message_id = p_provider_message_id and e.kind = 'failed'
       order by e.id limit 1;
      if found then
        perform public.notification_advance_status(v_n.id, 'failed', v_orphan_failed.error_code);
      end if;
    end if;

  elsif p_outcome = 'retry' then
    if v_n.attempts >= v_n.max_attempts then
      update public.notifications n
         set status = 'failed', lease_id = null, locked_until = null,
             last_error_code = coalesce(v_error, n.last_error_code), updated_at = now()
       where n.id = v_n.id;
    else
      update public.notifications n
         set status = 'pending', lease_id = null, locked_until = null,
             next_attempt_at = now() + least(power(2, n.attempts - 1) * interval '1 minute', interval '60 minutes'),
             last_error_code = coalesce(v_error, n.last_error_code), updated_at = now()
       where n.id = v_n.id;
    end if;
    insert into public.notification_events (notification_id, bureau_id, kind, error_code)
    values (v_n.id, v_n.bureau_id, 'attempt_failed', v_error);
    if v_n.attempts >= v_n.max_attempts then
      insert into public.notification_events (notification_id, bureau_id, kind, error_code)
      values (v_n.id, v_n.bureau_id, 'failed', v_error);
    end if;

  elsif p_outcome = 'failed' then
    update public.notifications n
       set status = 'failed', lease_id = null, locked_until = null,
           last_error_code = coalesce(v_error, n.last_error_code), updated_at = now()
     where n.id = v_n.id;
    insert into public.notification_events (notification_id, bureau_id, kind, error_code)
    values (v_n.id, v_n.bureau_id, 'failed', v_error);

  else
    update public.notifications n
       set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null,
           last_error_code = coalesce(v_error, n.last_error_code), updated_at = now()
     where n.id = v_n.id;
    insert into public.notification_events (notification_id, bureau_id, kind, error_code)
    values (v_n.id, v_n.bureau_id, 'suppressed', v_error);
  end if;
  return 'applied';
end
$$;

-- Status da Meta (app_webhook). O evento entra no log mesmo quando o estado não avança.
-- Resultado: applied | duplicate | orphan | ignored.
create function apply_whatsapp_status(
  p_provider_message_id text,
  p_status text,
  p_error_code text,
  p_occurred_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_bureau uuid;
  v_event bigint;
begin
  if p_provider_message_id is null or btrim(p_provider_message_id) = ''
     or p_status is null or p_status not in ('sent', 'delivered', 'read', 'failed') then
    return 'ignored';
  end if;
  perform pg_advisory_xact_lock(hashtext('notification-provider:' || p_provider_message_id));

  select n.id, n.bureau_id into v_id, v_bureau
    from public.notifications n where n.provider_message_id = p_provider_message_id;

  insert into public.notification_events
    (notification_id, bureau_id, kind, error_code, provider_message_id, dedupe_key, occurred_at)
  values
    (v_id, v_bureau, p_status, left(p_error_code, 64), p_provider_message_id,
     'meta:' || p_provider_message_id || ':' || p_status, coalesce(p_occurred_at, now()))
  on conflict (dedupe_key) do nothing
  returning id into v_event;
  if v_event is null then
    return 'duplicate';
  end if;
  if v_id is null then
    return 'orphan';
  end if;
  if public.notification_advance_status(v_id, p_status, p_error_code) then
    return 'applied';
  end if;
  return 'ignored';
end
$$;

create function record_notification_opt_out(p_channel text, p_recipient text)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.notification_opt_outs (channel, recipient_hash, source)
  values (p_channel, public.notification_recipient_hash(p_recipient), 'whatsapp_keyword')
  on conflict do nothing
$$;

-- Nova tentativa manual de uma notificação failed. Só o superadmin sem suporte, e só dentro da
-- retenção de 7 dias (depois o claim apaga recipient e params).
create function retry_notification(p_notification_id uuid)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_n public.notifications;
begin
  if not public.app_context_present() or public.app_user_role() <> 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  select * into v_n from public.notifications where id = p_notification_id for update;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if v_n.status <> 'failed' then
    return query select false, 'invalid_state'::text;
    return;
  end if;
  if v_n.recipient is null or v_n.params is null then
    return query select false, 'payload_purged'::text;
    return;
  end if;
  update public.notifications
     set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
   where id = v_n.id;
  insert into public.notification_events (notification_id, bureau_id, kind)
  values (v_n.id, v_n.bureau_id, 'retried');
  return query select true, null::text;
end
$$;

alter table notification_templates owner to schema_owner;
alter table notifications owner to schema_owner;
alter table notification_events owner to schema_owner;
alter table notification_opt_outs owner to schema_owner;
alter function notification_recipient_hash(text) owner to schema_owner;
alter function notifications_no_delete() owner to schema_owner;
alter function notification_templates_guard() owner to schema_owner;
alter function notification_events_guard() owner to schema_owner;
alter function enqueue_notification(text, text, text, text, jsonb, text, text) owner to auth_profile_lookup;
alter function supersede_notifications(text, text) owner to auth_profile_lookup;
alter function claim_notifications(integer) owner to auth_profile_lookup;
alter function notification_advance_status(uuid, text, text) owner to auth_profile_lookup;
alter function complete_notification(uuid, uuid, text, text, text) owner to auth_profile_lookup;
alter function apply_whatsapp_status(text, text, text, timestamptz) owner to auth_profile_lookup;
alter function record_notification_opt_out(text, text) owner to auth_profile_lookup;
alter function retry_notification(uuid) owner to auth_profile_lookup;

revoke all on function notification_recipient_hash(text) from public;
revoke all on function notifications_no_delete() from public;
revoke all on function notification_templates_guard() from public;
revoke all on function notification_events_guard() from public;
revoke all on function enqueue_notification(text, text, text, text, jsonb, text, text) from public;
revoke all on function supersede_notifications(text, text) from public;
revoke all on function claim_notifications(integer) from public;
revoke all on function notification_advance_status(uuid, text, text) from public;
revoke all on function complete_notification(uuid, uuid, text, text, text) from public;
revoke all on function apply_whatsapp_status(text, text, text, timestamptz) from public;
revoke all on function record_notification_opt_out(text, text) from public;
revoke all on function retry_notification(uuid) from public;
grant execute on function notification_recipient_hash(text) to auth_profile_lookup;
grant execute on function enqueue_notification(text, text, text, text, jsonb, text, text) to app_runtime;
grant execute on function retry_notification(uuid) to app_runtime;
grant execute on function supersede_notifications(text, text) to app_runtime;
grant execute on function claim_notifications(integer) to app_webhook;
grant execute on function complete_notification(uuid, uuid, text, text, text) to app_webhook;
grant execute on function apply_whatsapp_status(text, text, text, timestamptz) to app_webhook;
grant execute on function record_notification_opt_out(text, text) to app_webhook;

alter table notification_templates enable row level security;
alter table notification_templates force row level security;
alter table notifications enable row level security;
alter table notifications force row level security;
alter table notification_events enable row level security;
alter table notification_events force row level security;
alter table notification_opt_outs enable row level security;
alter table notification_opt_outs force row level security;

-- Staff lê as notificações do próprio Bureau. O superadmin sem suporte lê tudo (só SELECT). client: nada.
create policy notifications_select on notifications for select using (
  (bureau_id = app_bureau_id() and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy notification_events_select on notification_events for select using (
  (bureau_id = app_bureau_id() and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy notification_templates_select on notification_templates for select using (
  app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null
);

revoke all on notification_templates, notifications, notification_events, notification_opt_outs
  from public, app_runtime, app_webhook, auth_profile_lookup;
grant select on notification_templates to app_runtime;
-- recipient, params, recipient_hash, idempotency_key, lease_id e provider_message_id ficam fora do alcance da aplicação.
grant select (id, bureau_id, template_id, channel, recipient_masked, reference, status, attempts, max_attempts,
  next_attempt_at, last_error_code, created_by, created_at, sent_at, updated_at) on notifications to app_runtime;
grant select (id, notification_id, bureau_id, kind, error_code, occurred_at, created_at)
  on notification_events to app_runtime;
grant select on notification_templates, notifications, notification_events, notification_opt_outs to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select on notification_templates to auth_profile_lookup;
grant select, insert,
  update (status, recipient, params, attempts, next_attempt_at, lease_id, locked_until, provider_message_id,
    last_error_code, sent_at, updated_at) on notifications to auth_profile_lookup;
grant select, insert, update (notification_id, bureau_id) on notification_events to auth_profile_lookup;
grant select, insert on notification_opt_outs to auth_profile_lookup;

create policy notification_templates_gateway_select on notification_templates for select to auth_profile_lookup using (true);
create policy notifications_gateway_select on notifications for select to auth_profile_lookup using (true);
create policy notifications_gateway_insert on notifications for insert to auth_profile_lookup with check (true);
create policy notifications_gateway_update on notifications for update to auth_profile_lookup using (true) with check (true);
create policy notification_events_gateway_select on notification_events for select to auth_profile_lookup using (true);
create policy notification_events_gateway_insert on notification_events for insert to auth_profile_lookup with check (true);
create policy notification_events_gateway_update on notification_events for update to auth_profile_lookup using (true) with check (true);
create policy notification_opt_outs_gateway_select on notification_opt_outs for select to auth_profile_lookup using (true);
create policy notification_opt_outs_gateway_insert on notification_opt_outs for insert to auth_profile_lookup with check (true);
