-- M3b: repasse ao Bureau (payouts, payout_items) e colunas de NFS-e em pix_charges.
-- A 003–015 já foram aplicadas e não mudam.
-- 1) payouts guarda o repasse; payout_items liga cada lançamento (acréscimo ou estorno) a um único repasse.
--    O lançamento "payout" (−) em bureau_payable_entries nasce ao marcar como pago e aponta para o repasse.
-- 2) create_payout, mark_payout_paid e cancel_payout são as únicas escritas. Só o superadmin sem suporte as executa.
-- 3) pix_charges ganha as colunas de NFS-e. set_nfse_status é do webhook (EXECUTE só para app_webhook);
--    request_nfse_retry é do superadmin.

create table payouts (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  cutoff_at timestamptz not null,
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_by uuid references profiles(id),
  receipt_object_key text,
  receipt_mime text,
  receipt_sha256 text,
  unique (bureau_id, id),
  -- Pago exige as cinco colunas; fora de pago nenhuma delas existe.
  constraint payouts_paid_complete check (
    (status = 'paid') = (
      paid_at is not null and paid_by is not null and receipt_object_key is not null
      and receipt_mime is not null and receipt_sha256 is not null
    )
  ),
  constraint payouts_unpaid_clean check (
    status = 'paid' or (
      paid_at is null and paid_by is null and receipt_object_key is null
      and receipt_mime is null and receipt_sha256 is null
    )
  ),
  constraint payouts_receipt_format check (
    receipt_object_key is null or (
      btrim(receipt_object_key) <> '' and length(receipt_object_key) <= 500
      and receipt_mime in ('application/pdf', 'image/png', 'image/jpeg')
      and receipt_sha256 ~ '^[0-9a-f]{64}$'
    )
  )
);

create index payouts_bureau_created_idx on payouts(bureau_id, created_at desc);

-- O lançamento "payout" aponta para o repasse (mark_payout_paid sempre preenche). Só ele pode ter payout_id.
alter table bureau_payable_entries add column payout_id uuid;
alter table bureau_payable_entries add constraint bureau_payable_entries_payout_fk
  foreign key (bureau_id, payout_id) references payouts(bureau_id, id);
alter table bureau_payable_entries add constraint bureau_payable_entries_payout_link
  check (kind = 'payout' or payout_id is null);
-- Um repasse gera no máximo um lançamento de pagamento.
create unique index bureau_payable_entries_payout_idx on bureau_payable_entries(payout_id) where kind = 'payout';

-- entry_id unique: um lançamento entra em um único repasse. Só acréscimo e estorno entram.
-- Sem FK para bureau_payable_entries: uma FK impede o TRUNCATE antes do gatilho da 015 e a tabela é só de INSERT;
-- o gatilho payout_items_check_entry confere o lançamento na inserção.
create table payout_items (
  payout_id uuid not null,
  entry_id uuid not null unique,
  bureau_id uuid not null,
  primary key (payout_id, entry_id),
  foreign key (bureau_id, payout_id) references payouts(bureau_id, id)
);

create index payout_items_bureau_idx on payout_items(bureau_id);

-- Repasse: só open -> paid | cancelled, e só nas colunas de pagamento. Nada se apaga.
create function payouts_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'open'
     and new.status in ('paid', 'cancelled')
     and (to_jsonb(new) - 'status' - 'paid_at' - 'paid_by' - 'receipt_object_key' - 'receipt_mime' - 'receipt_sha256')
         = (to_jsonb(old) - 'status' - 'paid_at' - 'paid_by' - 'receipt_object_key' - 'receipt_mime' - 'receipt_sha256') then
    return new;
  end if;
  raise exception 'payouts allows only the open transitions' using errcode = 'check_violation';
end
$$;

create trigger payouts_guard before update or delete on payouts
  for each row execute function payouts_guard();
create trigger payouts_no_truncate before truncate on payouts
  for each statement execute function payouts_guard();

-- Itens: a única exclusão permitida é a do cancelamento de um repasse ainda aberto (cancel_payout).
create function payout_items_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE'
     and exists (select 1 from public.payouts p where p.id = old.payout_id and p.status = 'open') then
    return old;
  end if;
  raise exception 'payout_items allows only the release of an open payout' using errcode = 'check_violation';
end
$$;

create function payout_items_check_entry()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.bureau_payable_entries e
     where e.id = new.entry_id and e.bureau_id = new.bureau_id and e.kind in ('accrual', 'reversal')
  ) then
    raise exception 'payout_items accepts only an accrual or reversal entry of the same Bureau'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

create trigger payout_items_check_entry before insert on payout_items
  for each row execute function payout_items_check_entry();
create trigger payout_items_guard before update or delete on payout_items
  for each row execute function payout_items_guard();
create trigger payout_items_no_truncate before truncate on payout_items
  for each statement execute function payout_items_guard();

alter table payouts enable row level security;
alter table payouts force row level security;
alter table payout_items enable row level security;
alter table payout_items force row level security;

-- O bureau_admin lê só os repasses do próprio Bureau. Exceção estreita: o superadmin sem suporte lê os de qualquer
-- Bureau (só SELECT, só estas duas tabelas). O operator e o cliente não leem.
create policy payouts_select on payouts for select using (
  (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);
create policy payout_items_select on payout_items for select using (
  (bureau_id = app_bureau_id() and app_user_role() = 'bureau_admin' and (select app_is_staff()))
  or (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
);

-- NFS-e. A aplicação nunca escreve estas colunas: só set_nfse_status e request_nfse_retry.
alter table pix_charges add column nfse_status text not null default 'not_requested'
  check (nfse_status in ('not_requested', 'pending', 'issued', 'failed'));
alter table pix_charges add column nfse_number text check (nfse_number is null or (btrim(nfse_number) <> '' and length(nfse_number) <= 50));
alter table pix_charges add column nfse_url text check (nfse_url is null or (nfse_url ~ '^https://[^[:space:]]+$' and length(nfse_url) <= 2000));
alter table pix_charges add column nfse_updated_at timestamptz;
alter table pix_charges add column nfse_attempts integer not null default 0 check (nfse_attempts >= 0);

-- Cria o repasse: trava o Bureau com um lock de transação (duas chamadas do mesmo Bureau se enfileiram e a segunda
-- já enxerga os itens da primeira), soma os lançamentos ainda sem repasse até o corte e grava repasse e itens.
-- Os ids saem de um único SELECT: o valor e os itens vêm do mesmo conjunto.
create function create_payout(p_bureau_id uuid, p_cutoff_at timestamptz)
returns table (ok boolean, reason text, payout_id uuid, amount numeric)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_amount numeric;
  v_payout uuid;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_cutoff_at is null then
    return query select false, 'invalid_cutoff'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_bureau_id is null or not exists (select 1 from public.bureaus b where b.id = p_bureau_id) then
    return query select false, 'not_found'::text, null::uuid, null::numeric;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payout:' || p_bureau_id::text, 0));

  select array_agg(e.id), sum(e.amount) into v_ids, v_amount
    from public.bureau_payable_entries e
   where e.bureau_id = p_bureau_id
     and e.kind in ('accrual', 'reversal')
     and e.created_at <= p_cutoff_at
     and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
  if v_ids is null or v_amount <= 0 then
    return query select false, 'nothing_to_pay'::text, null::uuid, null::numeric;
    return;
  end if;

  insert into public.payouts (bureau_id, cutoff_at, amount, created_by)
  values (p_bureau_id, p_cutoff_at, v_amount, public.app_user_id())
  returning id into v_payout;
  insert into public.payout_items (payout_id, entry_id, bureau_id)
  select v_payout, e.id, e.bureau_id
    from public.bureau_payable_entries e where e.id = any(v_ids);

  return query select true, null::text, v_payout, v_amount;
end
$$;

-- Marca como pago: exige repasse aberto e comprovante completo, grava o lançamento "payout" (−valor).
-- Repetir com o mesmo comprovante (sha256) devolve ok sem duplicar; outro comprovante devolve already_paid.
create function mark_payout_paid(p_payout_id uuid, p_object_key text, p_mime text, p_sha256 text)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_payout public.payouts;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_payout.status = 'cancelled' then
    return query select false, 'invalid_state'::text, v_payout.status;
    return;
  end if;
  if v_payout.status = 'paid' then
    if v_payout.receipt_sha256 is not distinct from p_sha256 then
      return query select true, null::text, v_payout.status;
    else
      return query select false, 'already_paid'::text, v_payout.status;
    end if;
    return;
  end if;
  if p_object_key is null or btrim(p_object_key) = '' or length(p_object_key) > 500
     or p_mime is null or p_mime not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    return query select false, 'invalid_receipt'::text, v_payout.status;
    return;
  end if;

  update public.payouts
     set status = 'paid', paid_at = now(), paid_by = public.app_user_id(),
         receipt_object_key = p_object_key, receipt_mime = p_mime, receipt_sha256 = p_sha256
   where id = v_payout.id;
  insert into public.bureau_payable_entries (bureau_id, kind, amount, payout_id)
  values (v_payout.bureau_id, 'payout', -v_payout.amount, v_payout.id);

  return query select true, null::text, 'paid'::text;
end
$$;

-- Cancela um repasse aberto: apaga os itens (os lançamentos voltam a ficar livres) e marca cancelled.
create function cancel_payout(p_payout_id uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_payout public.payouts;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_payout from public.payouts where id = p_payout_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_payout.status = 'cancelled' then
    return query select true, null::text, v_payout.status;
    return;
  end if;
  if v_payout.status = 'paid' then
    return query select false, 'invalid_state'::text, v_payout.status;
    return;
  end if;

  delete from public.payout_items where payout_id = v_payout.id;
  update public.payouts set status = 'cancelled' where id = v_payout.id;

  return query select true, null::text, 'cancelled'::text;
end
$$;

-- Webhook sem sessão: quem chama é só app_webhook (o EXECUTE é a autorização). Transições permitidas:
-- not_requested -> qualquer; pending -> issued | failed; failed -> issued. issued é final; repetir não muda nada.
-- A nota nunca toca carteira nem lançamento.
create function set_nfse_status(p_charge_id uuid, p_status text, p_number text, p_url text)
returns table (ok boolean, reason text, status text, changed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_charge public.pix_charges;
  v_change boolean;
begin
  if p_status is null or p_status not in ('pending', 'issued', 'failed') then
    return query select false, 'invalid_status'::text, null::text, false;
    return;
  end if;
  if p_number is not null and (btrim(p_number) = '' or length(p_number) > 50) then
    return query select false, 'invalid_number'::text, null::text, false;
    return;
  end if;
  if p_url is not null and (p_url !~ '^https://[^[:space:]]+$' or length(p_url) > 2000) then
    return query select false, 'invalid_url'::text, null::text, false;
    return;
  end if;

  select * into v_charge from public.pix_charges where id = p_charge_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text, false;
    return;
  end if;
  if v_charge.status not in ('paid', 'refunded') then
    return query select false, 'invalid_state'::text, v_charge.nfse_status, false;
    return;
  end if;

  v_change := v_charge.nfse_status = 'not_requested'
    or (v_charge.nfse_status = 'pending' and p_status in ('issued', 'failed'))
    or (v_charge.nfse_status = 'failed' and p_status = 'issued');
  if not v_change then
    return query select true, null::text, v_charge.nfse_status, false;
    return;
  end if;

  update public.pix_charges
     set nfse_status = p_status,
         nfse_number = coalesce(p_number, nfse_number),
         nfse_url = coalesce(p_url, nfse_url),
         nfse_updated_at = now()
   where id = v_charge.id;
  return query select true, null::text, p_status, true;
end
$$;

-- Nova tentativa manual: só nota failed volta a pending, e conta a tentativa.
create function request_nfse_retry(p_charge_id uuid)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_charge public.pix_charges;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;

  select * into v_charge from public.pix_charges where id = p_charge_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_charge.nfse_status <> 'failed' then
    return query select false, 'invalid_state'::text, v_charge.nfse_status;
    return;
  end if;

  update public.pix_charges
     set nfse_status = 'pending', nfse_attempts = nfse_attempts + 1, nfse_updated_at = now()
   where id = v_charge.id;
  return query select true, null::text, 'pending'::text;
end
$$;

-- Lista das notas que falharam, para a tela de nova tentativa. É uma função, não uma política em pix_charges:
-- o superadmin continua sem ler cobranças de Bureau algum. Só dados da cobrança, sem pix_payload.
create function list_failed_nfse(p_limit integer default 100)
returns table (charge_id uuid, bureau_id uuid, amount numeric, charge_status text, nfse_attempts integer,
  nfse_updated_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return;
  end if;
  return query
    select c.id, c.bureau_id, c.amount, c.status, c.nfse_attempts, c.nfse_updated_at, c.created_at
      from public.pix_charges c
     where c.nfse_status = 'failed'
     order by c.nfse_updated_at desc nulls last, c.id
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$$;

alter table payouts owner to schema_owner;
alter table payout_items owner to schema_owner;
alter function payouts_guard() owner to schema_owner;
alter function payout_items_guard() owner to schema_owner;
alter function payout_items_check_entry() owner to schema_owner;
alter function create_payout(uuid, timestamptz) owner to auth_profile_lookup;
alter function mark_payout_paid(uuid, text, text, text) owner to auth_profile_lookup;
alter function cancel_payout(uuid) owner to auth_profile_lookup;
alter function set_nfse_status(uuid, text, text, text) owner to auth_profile_lookup;
alter function request_nfse_retry(uuid) owner to auth_profile_lookup;
alter function list_failed_nfse(integer) owner to auth_profile_lookup;

revoke all on function payouts_guard() from public;
revoke all on function payout_items_guard() from public;
revoke all on function payout_items_check_entry() from public;
revoke all on function create_payout(uuid, timestamptz) from public;
revoke all on function mark_payout_paid(uuid, text, text, text) from public;
revoke all on function cancel_payout(uuid) from public;
revoke all on function request_nfse_retry(uuid) from public;
revoke all on function list_failed_nfse(integer) from public;
grant execute on function create_payout(uuid, timestamptz) to app_runtime;
grant execute on function mark_payout_paid(uuid, text, text, text) to app_runtime;
grant execute on function cancel_payout(uuid) to app_runtime;
grant execute on function request_nfse_retry(uuid) to app_runtime;
grant execute on function list_failed_nfse(integer) to app_runtime;
-- Só app_webhook executa set_nfse_status; app_runtime não, para que uma injeção de SQL na aplicação não
-- consiga fabricar nota.
revoke all on function set_nfse_status(uuid, text, text, text) from public, app_runtime;
grant execute on function set_nfse_status(uuid, text, text, text) to app_webhook;

revoke all on payouts, payout_items from public, app_runtime, auth_profile_lookup;
grant select on payouts, payout_items to app_runtime;
grant select on payouts, payout_items to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select, insert (bureau_id, cutoff_at, amount, created_by),
  update (status, paid_at, paid_by, receipt_object_key, receipt_mime, receipt_sha256) on payouts to auth_profile_lookup;
grant select, insert, delete on payout_items to auth_profile_lookup;
grant update (nfse_status, nfse_number, nfse_url, nfse_updated_at, nfse_attempts) on pix_charges to auth_profile_lookup;

create policy payouts_gateway_select on payouts for select to auth_profile_lookup using (true);
create policy payouts_gateway_insert on payouts for insert to auth_profile_lookup with check (true);
create policy payouts_gateway_update on payouts for update to auth_profile_lookup
  using (true) with check (true);
create policy payout_items_gateway_select on payout_items for select to auth_profile_lookup using (true);
create policy payout_items_gateway_insert on payout_items for insert to auth_profile_lookup with check (true);
create policy payout_items_gateway_delete on payout_items for delete to auth_profile_lookup using (true);
