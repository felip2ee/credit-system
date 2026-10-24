-- M7: retenção LGPD. A 001-022 já foram aplicadas e não mudam.
-- Prazos (hipótese a confirmar com o jurídico):
--   código de verificação, sessão expirada: 24 h após expires_at   -> apagar (lgpd_purge_technical)
--   tentativa de cadastro por IP:           30 dias                -> apagar (lgpd_purge_technical)
--   Titular e dados de consulta:            5 anos sem atividade   -> anonimizar (lgpd_purge_bureau) ou a pedido
--   autorização SCR:                        5 anos após expires_at, refused_at, request_expires_at ou created_at -> apagar (lgpd_purge_bureau)
--   pedido, razão, pagamento, repasse, NFS-e, auditoria, aceite de termos: mantidos (fiscal / append-only).
-- Toda escrita passa por função SECURITY DEFINER com dono lgpd_owner (role própria, NOLOGIN), sob as políticas *_lgpd_* abaixo.
-- auth_profile_lookup não ganha nenhum privilégio novo. app_runtime executa só as funções lgpd_*.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lgpd_owner') then
    create role lgpd_owner nologin;
  end if;
end
$$;
-- Mesmos atributos reais de auth_profile_lookup (a 009 tirou o BYPASSRLS): as políticas abaixo valem.
alter role lgpd_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
grant lgpd_owner to schema_owner;
grant usage on schema public to lgpd_owner;
-- As políticas sem TO (as de equipe) valem para todo papel e chamam estes helpers.
grant execute on function app_user_id(), app_user_role(), app_bureau_id(), app_support_session_id(),
  app_context_present(), app_support_active(), app_is_staff() to lgpd_owner;

alter table holders alter column document drop not null;
alter table consultations alter column document drop not null;
alter table bureau_results alter column document drop not null;
alter table holders add column anonymized_at timestamptz;
alter table profiles add column anonymized_at timestamptz;

-- O pedido guarda o nome do Titular. Só a anonimização muda esse campo, e só para o texto fixo abaixo.
create or replace function public.dossier_orders_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_mutable text[] := array['state', 'state_reason', 'ai_status', 'ai_attempts', 'attempts',
    'next_attempt_at', 'lease_until', 'released_at', 'released_by', 'revoked_at', 'revoked_by',
    'revoke_reason', 'updated_at'];
begin
  if tg_op <> 'UPDATE' then
    raise exception 'dossier_orders allows no delete' using errcode = 'check_violation';
  end if;
  if new.subject_name = 'Titular anonimizado' then
    v_mutable := array_append(v_mutable, 'subject_name');
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

-- Titular anonimizado não muda mais, e só a função de anonimização (dono lgpd_owner) mexe em anonymized_at.
create function public.holders_anonymized_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user = 'lgpd_owner' then
    return new;
  end if;
  if old.anonymized_at is not null then
    raise exception 'holders: anonymized holder does not change' using errcode = 'check_violation';
  end if;
  if new.anonymized_at is distinct from old.anonymized_at then
    raise exception 'holders: anonymized_at changes only through lgpd_anonymize_holder' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function public.holders_anonymized_guard() owner to schema_owner;
revoke all on function public.holders_anonymized_guard() from public;
create trigger holders_anonymized_guard before update on public.holders
  for each row execute function public.holders_anonymized_guard();

-- Igual à 021, mais o dono das funções LGPD (anonimização da conta limpa telefone e canal).
create or replace function public.protect_profile_contact()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('auth_profile_lookup', 'schema_owner', 'lgpd_owner') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.phone_e164 is not null or new.phone_verified_at is not null or new.notification_channel <> 'email' then
      raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
    end if;
  elsif row(old.phone_e164, old.phone_verified_at, old.notification_channel)
        is distinct from row(new.phone_e164, new.phone_verified_at, new.notification_channel) then
    raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
  end if;
  return new;
end
$$;

-- Anonimiza um Titular do Bureau do contexto. Quem chama: bureau_admin ou o perfil de sistema (tick).
create or replace function public.lgpd_anonymize_holder(p_holder_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bureau uuid := public.app_bureau_id();
  v_anonymized_at timestamptz;
  v_client uuid;
begin
  if v_bureau is null or not coalesce(
       public.app_user_role() = 'bureau_admin'
       or exists (select 1 from public.profiles p
                   where p.id = public.app_user_id() and p.is_system and p.bureau_id = v_bureau), false) then
    return 'not_found';
  end if;

  select h.anonymized_at, h.client_profile_id into v_anonymized_at, v_client
    from public.holders h
   where h.id = p_holder_id and h.bureau_id = v_bureau
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_anonymized_at is not null then
    return 'already_anonymized';
  end if;
  -- A conta ligada ao Titular compra com esses dados: anonimiza-se a conta primeiro.
  if exists (select 1 from public.profiles p where p.id = v_client and p.is_active and p.anonymized_at is null) then
    return 'client_active';
  end if;
  if exists (
       select 1 from public.dossier_orders o
         join public.dossiers d on d.id = o.dossier_id and d.bureau_id = o.bureau_id
        where d.holder_id = p_holder_id and o.bureau_id = v_bureau
          and o.state not in ('completed', 'released', 'cancelled', 'failed')) then
    return 'open_orders';
  end if;

  -- bureau_results aponta para bureau_payloads sem cascade: apaga o resultado primeiro.
  delete from public.bureau_results r
   using public.consultations c
   where c.id = r.consultation_id and c.bureau_id = r.bureau_id
     and c.holder_id = p_holder_id and c.bureau_id = v_bureau;
  delete from public.bureau_payloads bp
   using public.consultations c
   where c.id = bp.consultation_id and c.bureau_id = bp.bureau_id
     and c.holder_id = p_holder_id and c.bureau_id = v_bureau;

  update public.consultations
     set document = null, document_name = null, scr_email = null, observations = null,
         error_message = null, share_link = null
   where holder_id = p_holder_id and bureau_id = v_bureau;

  update public.ai_reports
     set executive_summary = null, positive_points = null, risk_points = null, action_plan = null,
         suggested_products = null, suggested_limit_notes = null, report_markdown = null, full_report = null,
         generation_error = null, consultant_notes = null
   where bureau_id = v_bureau
     and consultation_id in (select c.id from public.consultations c where c.holder_id = p_holder_id and c.bureau_id = v_bureau);

  update public.dossiers
     set executive_summary = null, positive_points = null, risk_points = null, action_plan = null,
         suggested_products = null, suggested_limit_notes = null, report_markdown = null, full_report = null,
         generation_error = null
   where holder_id = p_holder_id and bureau_id = v_bureau;

  delete from public.crm_notes n
   where n.bureau_id = v_bureau
     and ((n.entity_type = 'holder' and n.entity_id = p_holder_id)
       or (n.entity_type = 'query'
           and n.entity_id in (select c.id from public.consultations c where c.holder_id = p_holder_id and c.bureau_id = v_bureau)));

  update public.timeline_events e
     set description = null, metadata = null
   where e.bureau_id = v_bureau
     and ((e.entity_type = 'holder' and e.entity_id = p_holder_id)
       or (e.entity_type = 'query'
           and e.entity_id in (select c.id from public.consultations c where c.holder_id = p_holder_id and c.bureau_id = v_bureau)));

  update public.dossier_orders o
     set subject_name = 'Titular anonimizado'
   where o.bureau_id = v_bureau
     and o.dossier_id in (select d.id from public.dossiers d where d.holder_id = p_holder_id and d.bureau_id = v_bureau);

  update public.holders
     set name = 'Titular anonimizado', document = null, email = null, phone = null, address = null,
         address_number = null, address_complement = null, neighborhood = null, city = null, state = null,
         zip_code = null, notes = null, anonymized_at = now()
   where id = p_holder_id and bureau_id = v_bureau;
  return 'ok';
end
$$;

-- Anonimiza a conta de um cliente do Bureau do contexto (bureau_admin). Não toca os Titulares dele.
create or replace function public.lgpd_anonymize_client_account(p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bureau uuid := public.app_bureau_id();
  v_user_id text;
  v_old_email text;
  v_anonymized_at timestamptz;
  v_email text := 'anon-' || p_profile_id || '@anonimizado.invalid';
begin
  if v_bureau is null or public.app_user_role() is distinct from 'bureau_admin' then
    return 'not_found';
  end if;

  select p.auth_user_id, p.email, p.anonymized_at into v_user_id, v_old_email, v_anonymized_at
    from public.profiles p
   where p.id = p_profile_id and p.role = 'client' and p.bureau_id = v_bureau
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_anonymized_at is not null then
    return 'already_anonymized';
  end if;
  if exists (select 1 from public.client_wallets w
              where w.client_profile_id = p_profile_id and (w.available <> 0 or w.reserved <> 0)) then
    return 'balance';
  end if;
  if exists (select 1 from public.dossier_orders o
              where o.client_profile_id = p_profile_id and o.bureau_id = v_bureau
                and o.state not in ('completed', 'released', 'cancelled', 'failed')) then
    return 'open_orders';
  end if;

  update public.profiles
     set full_name = 'Conta anonimizada', email = v_email, phone_e164 = null, phone_verified_at = null,
         notification_channel = 'email', is_active = false, anonymized_at = now()
   where id = p_profile_id;
  update public."user" set name = 'Conta anonimizada', email = v_email where id = v_user_id;
  delete from public."session" where user_id = v_user_id;
  delete from public.account where user_id = v_user_id;
  delete from public.two_factor where user_id = v_user_id;
  delete from public.verification where value = v_user_id or lower(identifier) = lower(v_old_email);
  -- target guarda o e-mail ou telefone em texto.
  delete from public.verification_challenges where profile_id = p_profile_id;
  return 'ok';
end
$$;

-- Varredura por Bureau: anonimiza Titular parado há 5 anos e apaga autorização SCR vencida há 5 anos.
-- No máximo p_limit Titulares por chamada; a falha de um Titular é contada e não para os outros.
-- Titular ligado a conta de cliente ativa fica de fora (lgpd_anonymize_holder devolve client_active).
create or replace function public.lgpd_purge_bureau(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bureau uuid := public.app_bureau_id();
  v_holder uuid;
  v_holders integer := 0;
  v_failed integer := 0;
  v_scr integer;
begin
  if v_bureau is null or not coalesce(
       public.app_user_role() = 'bureau_admin'
       or exists (select 1 from public.profiles p
                   where p.id = public.app_user_id() and p.is_system and p.bureau_id = v_bureau), false) then
    return '{}'::jsonb;
  end if;

  for v_holder in
    select h.id from public.holders h
     where h.bureau_id = v_bureau and h.anonymized_at is null
       and not exists (select 1 from public.profiles cp where cp.id = h.client_profile_id and cp.is_active and cp.anonymized_at is null)
       and greatest(
             h.updated_at,
             coalesce((select max(d.completed_at) from public.dossiers d where d.holder_id = h.id and d.bureau_id = h.bureau_id), '-infinity'),
             coalesce((select max(c.consulted_at) from public.consultations c where c.holder_id = h.id and c.bureau_id = h.bureau_id), '-infinity')
           ) < now() - interval '5 years'
     order by h.id
     limit greatest(p_limit, 0)
  loop
    begin
      if public.lgpd_anonymize_holder(v_holder) = 'ok' then
        v_holders := v_holders + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  -- consultations.scr_authorization_id não tem cascade: solta a referência antes de apagar.
  -- Recusada, cancelada ou nunca respondida não tem expires_at: vale a data do último fato conhecido.
  update public.consultations
     set scr_authorization_id = null
   where bureau_id = v_bureau
     and scr_authorization_id in (select a.id from public.scr_authorizations a
                                   where a.bureau_id = v_bureau
                                     and coalesce(a.expires_at, a.refused_at, a.request_expires_at, a.created_at) < now() - interval '5 years');
  delete from public.scr_authorizations a
   where a.bureau_id = v_bureau
     and coalesce(a.expires_at, a.refused_at, a.request_expires_at, a.created_at) < now() - interval '5 years';
  get diagnostics v_scr = row_count;

  return jsonb_build_object('holders_anonymized', v_holders, 'holders_failed', v_failed, 'scr_authorizations', v_scr);
end
$$;

-- Varredura sem tenant: dados técnicos com prazo em horas ou dias.
create or replace function public.lgpd_purge_technical()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_challenges integer;
  v_attempts integer;
  v_sessions integer;
  v_verifications integer;
begin
  if public.app_user_role() = 'client' then
    return '{}'::jsonb;
  end if;
  delete from public.verification_challenges where expires_at < now() - interval '24 hours';
  get diagnostics v_challenges = row_count;
  delete from public.client_register_attempts where created_at < now() - interval '30 days';
  get diagnostics v_attempts = row_count;
  delete from public."session" where expires_at < now() - interval '24 hours';
  get diagnostics v_sessions = row_count;
  delete from public.verification where expires_at < now() - interval '24 hours';
  get diagnostics v_verifications = row_count;
  return jsonb_build_object('verification_challenges', v_challenges, 'client_register_attempts', v_attempts,
                            'session', v_sessions, 'verification', v_verifications);
end
$$;

-- Alvos da varredura: Bureaus ativos com perfil de sistema e sem varredura nas últimas 24 h.
-- O tick roda como operator e não lê audit_logs; por isso a regra das 24 h vive aqui.
create or replace function public.lgpd_sweep_targets()
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
     and not exists (
       select 1 from public.audit_logs a
        where a.bureau_id = b.id and a.action = 'lgpd.purge_bureau' and a.created_at > now() - interval '24 hours')
$$;

-- ALTER OWNER exige CREATE no schema para o novo dono: concedido só durante a troca.
grant create on schema public to lgpd_owner;
alter function public.lgpd_anonymize_holder(uuid) owner to lgpd_owner;
alter function public.lgpd_anonymize_client_account(uuid) owner to lgpd_owner;
alter function public.lgpd_purge_bureau(integer) owner to lgpd_owner;
alter function public.lgpd_purge_technical() owner to lgpd_owner;
alter function public.lgpd_sweep_targets() owner to lgpd_owner;
revoke create on schema public from lgpd_owner;
revoke all on function public.lgpd_anonymize_holder(uuid) from public;
revoke all on function public.lgpd_anonymize_client_account(uuid) from public;
revoke all on function public.lgpd_purge_bureau(integer) from public;
revoke all on function public.lgpd_purge_technical() from public;
revoke all on function public.lgpd_sweep_targets() from public;
grant execute on function public.lgpd_anonymize_holder(uuid) to app_runtime;
grant execute on function public.lgpd_anonymize_client_account(uuid) to app_runtime;
grant execute on function public.lgpd_purge_bureau(integer) to app_runtime;
grant execute on function public.lgpd_purge_technical() to app_runtime;
grant execute on function public.lgpd_sweep_targets() to app_runtime;

-- Dono das funções: só o que elas leem e escrevem, e só sob as políticas abaixo.
grant select (id, bureau_id, client_profile_id, anonymized_at, updated_at),
  update (name, document, email, phone, address, address_number, address_complement,
  neighborhood, city, state, zip_code, notes, anonymized_at) on public.holders to lgpd_owner;
grant select (id, holder_id, bureau_id, consulted_at, scr_authorization_id),
  update (document, document_name, scr_email, observations, error_message, share_link, scr_authorization_id)
  on public.consultations to lgpd_owner;
grant select (id, holder_id, bureau_id, completed_at),
  update (executive_summary, positive_points, risk_points, action_plan, suggested_products, suggested_limit_notes,
          report_markdown, full_report, generation_error) on public.dossiers to lgpd_owner;
grant select (bureau_id, consultation_id),
  update (executive_summary, positive_points, risk_points, action_plan, suggested_products, suggested_limit_notes,
          report_markdown, full_report, generation_error, consultant_notes) on public.ai_reports to lgpd_owner;
grant select (bureau_id, consultation_id), delete on public.bureau_results to lgpd_owner;
grant select (bureau_id, consultation_id), delete on public.bureau_payloads to lgpd_owner;
grant select (bureau_id, entity_type, entity_id), delete on public.crm_notes to lgpd_owner;
grant select (bureau_id, entity_type, entity_id), update (description, metadata) on public.timeline_events to lgpd_owner;
grant select (bureau_id, dossier_id, client_profile_id, state), update (subject_name) on public.dossier_orders to lgpd_owner;
grant select (id, bureau_id, expires_at, refused_at, request_expires_at, created_at), delete on public.scr_authorizations to lgpd_owner;
grant select (bureau_id, client_profile_id, available, reserved) on public.client_wallets to lgpd_owner;
grant select (profile_id, expires_at), delete on public.verification_challenges to lgpd_owner;
grant select (created_at), delete on public.client_register_attempts to lgpd_owner;
grant select (id, role, bureau_id, auth_user_id, email, is_system, is_active, anonymized_at),
  update (full_name, email, phone_e164, phone_verified_at, notification_channel, is_active, anonymized_at)
  on public.profiles to lgpd_owner;
grant select (id), update (name, email) on public."user" to lgpd_owner;
grant select (user_id), delete on public.account to lgpd_owner;
grant select (user_id), delete on public.two_factor to lgpd_owner;
grant select (user_id, expires_at), delete on public."session" to lgpd_owner;
grant select (identifier, value, expires_at), delete on public.verification to lgpd_owner;
grant select (id, status) on public.bureaus to lgpd_owner;
grant select (bureau_id, action, created_at) on public.audit_logs to lgpd_owner;

create policy holders_lgpd_select on holders for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy holders_lgpd_update on holders for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy consultations_lgpd_select on consultations for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy consultations_lgpd_update on consultations for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy dossiers_lgpd_select on dossiers for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy dossiers_lgpd_update on dossiers for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy ai_reports_lgpd_select on ai_reports for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy ai_reports_lgpd_update on ai_reports for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy bureau_results_lgpd_select on bureau_results for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy bureau_results_lgpd_delete on bureau_results for delete to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy bureau_payloads_lgpd_select on bureau_payloads for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy bureau_payloads_lgpd_delete on bureau_payloads for delete to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy crm_notes_lgpd_select on crm_notes for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy crm_notes_lgpd_delete on crm_notes for delete to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy timeline_events_lgpd_select on timeline_events for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy timeline_events_lgpd_update on timeline_events for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy dossier_orders_lgpd_select on dossier_orders for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy dossier_orders_lgpd_update on dossier_orders for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy scr_authorizations_lgpd_select on scr_authorizations for select to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy scr_authorizations_lgpd_delete on scr_authorizations for delete to lgpd_owner
  using (bureau_id = app_bureau_id());
create policy client_wallets_lgpd_select on client_wallets for select to lgpd_owner
  using (bureau_id = app_bureau_id());
-- Sem tenant: a varredura técnica apaga por prazo.
create policy verification_challenges_lgpd_select on verification_challenges for select to lgpd_owner
  using (true);
create policy verification_challenges_lgpd_delete on verification_challenges for delete to lgpd_owner
  using (true);
create policy client_register_attempts_lgpd_select on client_register_attempts for select to lgpd_owner
  using (true);
create policy client_register_attempts_lgpd_delete on client_register_attempts for delete to lgpd_owner
  using (true);
-- O perfil de sistema aparece para a listagem de alvos; os demais só dentro do Bureau do contexto.
create policy profiles_lgpd_select on profiles for select to lgpd_owner
  using (bureau_id = app_bureau_id() or is_system);
create policy profiles_lgpd_update on profiles for update to lgpd_owner
  using (bureau_id = app_bureau_id()) with check (bureau_id = app_bureau_id());
create policy bureaus_lgpd_select on bureaus for select to lgpd_owner
  using (true);
create policy audit_logs_lgpd_select on audit_logs for select to lgpd_owner
  using (action = 'lgpd.purge_bureau');
