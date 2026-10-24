-- Programa de afiliados, núcleo.
-- 1) affiliate_codes / affiliate_referrals: cada cliente tem um código de 8 caracteres [a-z0-9]; o vínculo nasce só no cadastro.
-- 2) affiliate_wallets / affiliate_ledger_entries: carteira de comissão separada de client_wallets (impede sacar crédito de recarga).
--    affiliate_wallet_post_entry é o único código que a escreve (trava a linha, valida, lança, atualiza o saldo).
-- 3) affiliate_commissions: uma comissão por pedido; só funções security definer escrevem (027 em diante).
-- 4) client_wallet_post_entry ganha o lançamento commission_credit (conversão de comissão em créditos).
-- 5) register_client ganha p_referral_code (assinatura nova: a antiga é removida).

-- Cliente antigo e novo ganham código e carteira zerada.
create function affiliate_new_code()
returns text
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  -- Bytes 0 a 3 de um uuid v4 são todos aleatórios (os bits de versão e variante ficam nos bytes 6 e 8).
  v_a bytea := uuid_send(gen_random_uuid());
  v_b bytea := uuid_send(gen_random_uuid());
  v_code text := '';
  i integer;
begin
  for i in 0..3 loop
    v_code := v_code
      || substr(v_alphabet, 1 + get_byte(v_a, i) % 36, 1)
      || substr(v_alphabet, 1 + get_byte(v_b, i) % 36, 1);
  end loop;
  return v_code;
end
$$;

create table affiliate_codes (
  profile_id uuid primary key references profiles(id),
  bureau_id uuid not null,
  code text not null unique check (code ~ '^[a-z0-9]{8}$'),
  created_at timestamptz not null default now(),
  foreign key (bureau_id, profile_id) references profiles(bureau_id, id)
);

-- Vínculo permanente e imutável: a conta indicada não troca de afiliado.
create table affiliate_referrals (
  referred_profile_id uuid primary key references profiles(id),
  affiliate_profile_id uuid not null references profiles(id),
  bureau_id uuid not null,
  created_at timestamptz not null default now(),
  check (referred_profile_id <> affiliate_profile_id),
  foreign key (bureau_id, referred_profile_id) references profiles(bureau_id, id),
  foreign key (bureau_id, affiliate_profile_id) references profiles(bureau_id, id)
);
create index affiliate_referrals_affiliate_idx on affiliate_referrals(affiliate_profile_id, created_at desc);
create trigger affiliate_referrals_immutable before update or delete on affiliate_referrals
  for each row execute function append_only_guard();
create trigger affiliate_referrals_no_truncate before truncate on affiliate_referrals
  for each statement execute function append_only_guard();

create table bureau_affiliate_settings (
  bureau_id uuid primary key references bureaus(id),
  default_pct numeric(5,2) not null default 0 check (default_pct between 0 and 100),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table affiliate_rates (
  bureau_id uuid not null,
  affiliate_profile_id uuid not null,
  pct numeric(5,2) not null check (pct between 0 and 100),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (bureau_id, affiliate_profile_id),
  foreign key (bureau_id, affiliate_profile_id) references profiles(bureau_id, id)
);

create table affiliate_wallets (
  profile_id uuid primary key references profiles(id),
  bureau_id uuid not null,
  pending numeric(15,2) not null default 0 check (pending >= 0),
  available numeric(15,2) not null default 0 check (available >= 0),
  foreign key (bureau_id, profile_id) references profiles(bureau_id, id)
);

create table affiliate_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  profile_id uuid not null,
  bureau_id uuid not null,
  kind text not null check (kind in (
    'commission', 'commission_release', 'commission_reversal', 'conversion',
    'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release')),
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  pending_after numeric(15,2) not null check (pending_after >= 0),
  available_after numeric(15,2) not null check (available_after >= 0),
  idempotency_key text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
  reference text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (profile_id, idempotency_key),
  foreign key (profile_id) references affiliate_wallets(profile_id),
  foreign key (bureau_id, profile_id) references profiles(bureau_id, id)
);
create index affiliate_ledger_entries_profile_seq_idx on affiliate_ledger_entries(profile_id, seq desc);
create trigger affiliate_ledger_entries_immutable before update or delete on affiliate_ledger_entries
  for each row execute function append_only_guard();
create trigger affiliate_ledger_entries_no_truncate before truncate on affiliate_ledger_entries
  for each statement execute function append_only_guard();

-- Escrita só por funções security definer. pct, margin e release_at ficam gravados: mudar a % não altera o passado.
create table affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  order_ref uuid not null unique,
  bureau_id uuid not null,
  affiliate_profile_id uuid not null,
  referred_profile_id uuid not null,
  pct numeric(5,2) not null check (pct between 0 and 100),
  margin numeric(15,2) not null check (margin > 0),
  amount numeric(15,2) not null check (amount > 0),
  reversed_amount numeric(15,2) not null default 0 check (reversed_amount between 0 and amount),
  status text not null default 'pending' check (status in ('pending', 'released', 'reversed')),
  release_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (bureau_id, affiliate_profile_id) references profiles(bureau_id, id),
  foreign key (bureau_id, referred_profile_id) references profiles(bureau_id, id)
);
create index affiliate_commissions_affiliate_idx on affiliate_commissions(affiliate_profile_id, created_at desc);
create index affiliate_commissions_referred_idx on affiliate_commissions(referred_profile_id);
create index affiliate_commissions_release_idx on affiliate_commissions(release_at) where status = 'pending';

-- Cria carteira e código (com nova tentativa se o código colidir). Idempotente.
create function affiliate_provision(p_profile_id uuid, p_bureau_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_try integer := 0;
begin
  insert into public.affiliate_wallets (profile_id, bureau_id) values (p_profile_id, p_bureau_id)
  on conflict (profile_id) do nothing;
  if exists (select 1 from public.affiliate_codes c where c.profile_id = p_profile_id) then
    return;
  end if;
  loop
    begin
      insert into public.affiliate_codes (profile_id, bureau_id, code)
      values (p_profile_id, p_bureau_id, public.affiliate_new_code());
      return;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try >= 10 then
        raise;
      end if;
    end;
  end loop;
end
$$;

create function affiliate_provision_for_client()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.affiliate_provision(new.id, new.bureau_id);
  return new;
end
$$;

create trigger profiles_create_affiliate after insert on profiles
  for each row when (new.role = 'client') execute function affiliate_provision_for_client();

-- Núcleo da carteira de comissão. Não autoriza ninguém: só as funções de comissão, conversão e saque a chamam.
create function affiliate_wallet_post_entry(
  p_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_created_by uuid
)
returns table (ok boolean, reason text, entry_id uuid, pending numeric, available numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau_id uuid;
  v_pending numeric;
  v_available numeric;
  v_pending_after numeric;
  v_available_after numeric;
  v_entry public.affiliate_ledger_entries;
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
       'commission', 'commission_release', 'commission_reversal', 'conversion',
       'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, pending, available into v_bureau_id, v_pending, v_available
    from public.affiliate_wallets where profile_id = p_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.affiliate_ledger_entries
   where profile_id = p_profile_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.pending_after, v_entry.available_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_pending_after := v_pending;
  v_available_after := v_available;
  case p_kind
    when 'commission' then
      v_pending_after := v_pending + p_amount;
    when 'commission_release' then
      v_pending_after := v_pending - p_amount;
      v_available_after := v_available + p_amount;
    when 'commission_reversal' then
      v_pending_after := v_pending - p_amount;
    when 'conversion', 'withdrawal_hold' then
      v_available_after := v_available - p_amount;
    when 'withdrawal_release' then
      v_available_after := v_available + p_amount;
    when 'withdrawal_paid' then
      null; -- só registro: o valor já saiu do disponível em withdrawal_hold
  end case;

  if v_pending_after < 0 or v_available_after < 0 then
    return query select false, 'insufficient_funds'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.affiliate_ledger_entries
    (profile_id, bureau_id, kind, amount, pending_after, available_after, idempotency_key, reference, created_by)
  values
    (p_profile_id, v_bureau_id, p_kind, p_amount, v_pending_after, v_available_after, p_idempotency_key,
     p_reference, p_created_by)
  returning id into v_id;
  update public.affiliate_wallets set pending = v_pending_after, available = v_available_after
   where profile_id = p_profile_id;

  return query select true, null::text, v_id, v_pending_after, v_available_after, false;
end
$$;

-- Backfill: clientes que já existem.
do $$
declare
  r record;
begin
  for r in select p.id, p.bureau_id from public.profiles p where p.role = 'client' loop
    perform public.affiliate_provision(r.id, r.bureau_id);
  end loop;
end
$$;

-- Lançamento commission_credit na carteira de créditos: a conversão da comissão entra em available.
do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
   where conrelid = 'public.client_ledger_entries'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%topup%';
  execute format('alter table public.client_ledger_entries drop constraint %I', v_name);
end
$$;
alter table client_ledger_entries add constraint client_ledger_entries_kind_check
  check (kind in ('topup', 'reserve', 'capture', 'release', 'reversal', 'commission_credit'));

-- Núcleo da carteira do cliente (018) com o lançamento commission_credit. Dono, search_path e grants não mudam.
create or replace function client_wallet_post_entry(
  p_client_profile_id uuid,
  p_kind text,
  p_amount numeric,
  p_idempotency_key text,
  p_reference text,
  p_reason text,
  p_created_by uuid
)
returns table (ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)
language plpgsql
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau_id uuid;
  v_available numeric;
  v_reserved numeric;
  v_available_after numeric;
  v_reserved_after numeric;
  v_entry public.client_ledger_entries;
  v_id uuid;
begin
  if p_kind not in ('topup', 'reserve', 'capture', 'release', 'reversal', 'commission_credit') then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    return query select false, 'invalid_key'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or abs(p_amount) > 99999999.99 or p_amount <= 0 then
    return query select false, 'invalid_amount'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select bureau_id, available, reserved into v_bureau_id, v_available, v_reserved
    from public.client_wallets where client_profile_id = p_client_profile_id for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  select * into v_entry from public.client_ledger_entries
   where client_profile_id = p_client_profile_id and idempotency_key = p_idempotency_key;
  if found then
    if v_entry.kind = p_kind and v_entry.amount = p_amount then
      return query select true, null::text, v_entry.id, v_entry.available_after, v_entry.reserved_after, true;
    else
      return query select false, 'idempotency_conflict'::text, null::uuid, null::numeric, null::numeric, false;
    end if;
    return;
  end if;

  v_available_after := v_available;
  v_reserved_after := v_reserved;
  case p_kind
    when 'topup', 'commission_credit' then
      v_available_after := v_available + p_amount;
    when 'reserve' then
      v_available_after := v_available - p_amount;
      v_reserved_after := v_reserved + p_amount;
    when 'capture' then
      v_reserved_after := v_reserved - p_amount;
    when 'release' then
      v_reserved_after := v_reserved - p_amount;
      v_available_after := v_available + p_amount;
    when 'reversal' then
      -- O dinheiro estornado sai do disponível; o que faltar sai da reserva, que deixa de ter lastro.
      v_available_after := greatest(v_available - p_amount, 0);
      v_reserved_after := v_reserved - greatest(p_amount - v_available, 0);
  end case;

  if v_available_after < 0 then
    return query select false, 'insufficient_balance'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;
  if v_reserved_after < 0 then
    return query select false, 'reservation_exceeded'::text, null::uuid, null::numeric, null::numeric, false;
    return;
  end if;

  insert into public.client_ledger_entries
    (bureau_id, client_profile_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by)
  values
    (v_bureau_id, p_client_profile_id, p_kind, p_amount, v_available_after, v_reserved_after, p_idempotency_key,
     p_reference, p_reason, p_created_by)
  returning id into v_id;
  update public.client_wallets set available = v_available_after, reserved = v_reserved_after
   where client_profile_id = p_client_profile_id;

  return query select true, null::text, v_id, v_available_after, v_reserved_after, false;
end
$$;

-- Cadastro com indicação. Assinatura nova: a de 13 parâmetros é removida e o owner, revoke e grant são refeitos (021).
drop function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text);

create function register_client(
  p_slug text,
  p_type text,
  p_name text,
  p_document_digits text,
  p_email text,
  p_phone_e164 text,
  p_password_hash text,
  p_terms_version integer,
  p_privacy_version integer,
  p_ip inet,
  p_user_agent text,
  p_email_token text,
  p_site_url text,
  p_referral_code text default null
)
returns table (ok boolean, reason text, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid;
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_name);
  v_id uuid := gen_random_uuid();
  v_reason text;
  v_aff record;
  -- IPv6 é agrupado por /64: um cliente tem o prefixo inteiro, não um endereço.
  v_bucket inet := case when family(p_ip) = 6 then network(set_masklen(p_ip, 64)) else p_ip end;
begin
  -- LimitByIp: toda chamada conta, com sucesso ou não. A linha fica mesmo com ok = false.
  perform pg_advisory_xact_lock(hashtextextended('client_register:' || coalesce(host(v_bucket), '-'), 0));
  delete from public.client_register_attempts where created_at < now() - interval '1 day';
  if (select count(*) from public.client_register_attempts a
       where a.ip is not distinct from v_bucket and a.created_at > now() - interval '1 hour') >= 10 then
    return query select false, 'rate_limited'::text, null::uuid;
    return;
  end if;
  insert into public.client_register_attempts (ip) values (v_bucket);

  if p_type is null or p_type not in ('PF', 'PJ')
     or p_document_digits is null
     or p_document_digits !~ (case p_type when 'PF' then '^[0-9]{11}$' else '^[0-9]{14}$' end)
     or v_name is null or length(v_name) not between 2 and 120
     or v_email is null or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$'
     or p_password_hash is null or length(p_password_hash) < 20
     or (p_user_agent is not null and length(p_user_agent) > 512) then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  select b.id into v_bureau from public.bureaus b where b.slug = p_slug and b.status = 'active';
  if not found then
    return query select false, 'bureau_not_found'::text, null::uuid;
    return;
  end if;

  if p_terms_version is distinct from public.legal_current_version('terms')
     or p_privacy_version is distinct from public.legal_current_version('privacy') then
    return query select false, 'outdated_terms'::text, null::uuid;
    return;
  end if;

  -- D3: Titular do mesmo documento no Bureau, ligado ou não a uma conta. O operador liga pelo convite.
  perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || p_document_digits, 0));
  if exists (select 1 from public.holders h where h.bureau_id = v_bureau and h.document_digits = p_document_digits) then
    return query select false, 'document_in_use'::text, null::uuid;
    return;
  end if;

  insert into public."user" (id, name, email, email_verified)
  values (v_id::text, v_name, v_email, false)
  on conflict ((lower(email))) do nothing;
  if not found then
    return query select false, 'email_in_use'::text, null::uuid;
    return;
  end if;

  insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
  values (gen_random_uuid()::text, 'local:credential', v_id::text, 'credential', v_id::text, p_password_hash, now());
  -- O trigger profiles_create_client_wallet (015) cria a carteira zerada.
  insert into public.profiles (id, auth_user_id, full_name, email, role, bureau_id, phone_e164)
  values (v_id, v_id::text, v_name, v_email, 'client', v_bureau, p_phone_e164);
  insert into public.holders (bureau_id, type, name, document, email, phone, client_profile_id, created_by)
  values (v_bureau, p_type::public.query_type, v_name, p_document_digits, v_email, p_phone_e164, v_id, v_id);
  insert into public.legal_acceptances (profile_id, document_id, ip, user_agent)
  select v_id, d.id, p_ip, p_user_agent
    from public.legal_documents d
   where (d.kind = 'terms' and d.version = p_terms_version)
      or (d.kind = 'privacy' and d.version = p_privacy_version);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata, ip_address, user_agent)
  values (v_bureau, v_id, 'client.register', 'profiles', v_id, jsonb_build_object('type', p_type), p_ip, p_user_agent);

  -- Indicação: código inválido, de outro Bureau, de conta anonimizada ou autoindicação é ignorado, sem erro.
  if p_referral_code ~ '^[a-z0-9]{8}$' then
    select c.profile_id, p.email, p.phone_e164 into v_aff
      from public.affiliate_codes c
      join public.profiles p on p.id = c.profile_id
     where c.code = p_referral_code and c.bureau_id = v_bureau and p.anonymized_at is null;
    if found
       and lower(v_aff.email) is distinct from v_email
       and v_aff.phone_e164 is distinct from p_phone_e164
       and not exists (select 1 from public.holders h
                        where h.client_profile_id = v_aff.profile_id and h.document_digits = p_document_digits) then
      insert into public.affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id)
      values (v_id, v_aff.profile_id, v_bureau);
      insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
      values (v_bureau, v_id, 'affiliate.referral_linked', 'profiles', v_id,
              jsonb_build_object('affiliate_profile_id', v_aff.profile_id));
    end if;
  end if;

  v_reason := public.account_issue_email_challenge(v_id, p_email_token, p_site_url);
  if v_reason is not null then
    raise exception 'email challenge failed: %', v_reason using errcode = '22023';
  end if;
  return query select true, null::text, v_id;
end
$$;

-- Listas do afiliado com os nomes dos indicados: o cliente não lê o perfil de outro cliente, então passam por estas funções.
-- Só o próprio afiliado (papel client, id da sessão) recebe linhas; nunca documento nem resultado de consulta.
create function affiliate_my_referrals()
returns table (name text, created_at timestamptz, total_spent numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.full_name, r.created_at,
         coalesce((select sum(s.price) from public.order_settlements s
                    where s.client_profile_id = r.referred_profile_id and s.mode = 'online' and s.status = 'captured'), 0)
    from public.affiliate_referrals r
    join public.profiles p on p.id = r.referred_profile_id
   where public.app_context_present() and public.app_user_role() = 'client'
     and r.affiliate_profile_id = public.app_user_id() and r.bureau_id = public.app_bureau_id()
   order by r.created_at desc
   limit 200
$$;

create function affiliate_my_commissions()
returns table (created_at timestamptz, referred_name text, product_name text, order_value numeric,
               amount numeric, status text, release_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.created_at, p.full_name, coalesce(pr.name, o.product_code), s.price, c.amount, c.status, c.release_at
    from public.affiliate_commissions c
    join public.profiles p on p.id = c.referred_profile_id
    left join public.order_settlements s on s.order_ref = c.order_ref
    left join public.dossier_orders o on o.dossier_id = c.order_ref
    left join public.products pr on pr.code = o.product_code
   where public.app_context_present() and public.app_user_role() = 'client'
     and c.affiliate_profile_id = public.app_user_id() and c.bureau_id = public.app_bureau_id()
   order by c.created_at desc
   limit 200
$$;

-- Dono, revoke e grant de tudo que a 026 cria.
alter table affiliate_codes owner to schema_owner;
alter table affiliate_referrals owner to schema_owner;
alter table bureau_affiliate_settings owner to schema_owner;
alter table affiliate_rates owner to schema_owner;
alter table affiliate_wallets owner to schema_owner;
alter table affiliate_ledger_entries owner to schema_owner;
alter table affiliate_commissions owner to schema_owner;
alter function affiliate_new_code() owner to schema_owner;
alter function affiliate_provision(uuid, uuid) owner to auth_profile_lookup;
alter function affiliate_provision_for_client() owner to auth_profile_lookup;
alter function affiliate_wallet_post_entry(uuid, text, numeric, text, text, uuid) owner to auth_profile_lookup;
alter function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text, text) owner to auth_profile_lookup;
alter function affiliate_my_referrals() owner to auth_profile_lookup;
alter function affiliate_my_commissions() owner to auth_profile_lookup;

revoke all on function affiliate_new_code() from public;
revoke all on function affiliate_provision(uuid, uuid) from public;
revoke all on function affiliate_provision_for_client() from public;
-- Interna: nenhuma role de aplicação executa.
revoke all on function affiliate_wallet_post_entry(uuid, text, numeric, text, text, uuid) from public, app_runtime;
revoke all on function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text, text) from public;
revoke all on function affiliate_my_referrals() from public;
revoke all on function affiliate_my_commissions() from public;
grant execute on function affiliate_new_code() to auth_profile_lookup;
grant execute on function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text, text) to app_runtime;
grant execute on function affiliate_my_referrals() to app_runtime;
grant execute on function affiliate_my_commissions() to app_runtime;

alter table affiliate_codes enable row level security;
alter table affiliate_codes force row level security;
alter table affiliate_referrals enable row level security;
alter table affiliate_referrals force row level security;
alter table bureau_affiliate_settings enable row level security;
alter table bureau_affiliate_settings force row level security;
alter table affiliate_rates enable row level security;
alter table affiliate_rates force row level security;
alter table affiliate_wallets enable row level security;
alter table affiliate_wallets force row level security;
alter table affiliate_ledger_entries enable row level security;
alter table affiliate_ledger_entries force row level security;
alter table affiliate_commissions enable row level security;
alter table affiliate_commissions force row level security;

-- O cliente lê só o que é dele; a equipe do Bureau lê os dados de afiliados do próprio Bureau.
create policy affiliate_codes_select_own on affiliate_codes for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and profile_id = app_user_id()
);
create policy affiliate_codes_select_staff on affiliate_codes for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy affiliate_referrals_select_own on affiliate_referrals for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and affiliate_profile_id = app_user_id()
);
create policy affiliate_referrals_select_staff on affiliate_referrals for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy affiliate_wallets_select_own on affiliate_wallets for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and profile_id = app_user_id()
);
create policy affiliate_ledger_entries_select_own on affiliate_ledger_entries for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and profile_id = app_user_id()
);
create policy affiliate_commissions_select_own on affiliate_commissions for select using (
  app_context_present() and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and affiliate_profile_id = app_user_id()
);
create policy affiliate_commissions_select_staff on affiliate_commissions for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
-- % do Bureau: a equipe lê; só o bureau_admin do próprio Bureau grava.
create policy bureau_affiliate_settings_select_staff on bureau_affiliate_settings for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy bureau_affiliate_settings_admin_insert on bureau_affiliate_settings for insert with check (
  app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id()
);
create policy bureau_affiliate_settings_admin_update on bureau_affiliate_settings for update
  using (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
  with check (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id());
create policy affiliate_rates_select_staff on affiliate_rates for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy affiliate_rates_admin_insert on affiliate_rates for insert with check (
  app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id()
);
create policy affiliate_rates_admin_update on affiliate_rates for update
  using (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
  with check (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id());
create policy affiliate_rates_admin_delete on affiliate_rates for delete
  using (app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id());

revoke all on affiliate_codes, affiliate_referrals, bureau_affiliate_settings, affiliate_rates, affiliate_wallets,
  affiliate_ledger_entries, affiliate_commissions from public, app_runtime, auth_profile_lookup;
grant select on affiliate_codes, affiliate_referrals, affiliate_wallets, affiliate_ledger_entries, affiliate_commissions
  to app_runtime;
grant select, insert, update on bureau_affiliate_settings to app_runtime;
grant select, insert, update, delete on affiliate_rates to app_runtime;
grant select on affiliate_codes, affiliate_referrals, bureau_affiliate_settings, affiliate_rates, affiliate_wallets,
  affiliate_ledger_entries, affiliate_commissions to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select, insert on affiliate_codes to auth_profile_lookup;
grant select, insert on affiliate_referrals to auth_profile_lookup;
grant select, insert (profile_id, bureau_id), update (pending, available) on affiliate_wallets to auth_profile_lookup;
grant select, insert on affiliate_ledger_entries to auth_profile_lookup;
grant select on affiliate_commissions to auth_profile_lookup;
grant select (anonymized_at) on public.profiles to auth_profile_lookup;
grant select (dossier_id, product_code) on public.dossier_orders to auth_profile_lookup;
grant select (code, name) on public.products to auth_profile_lookup;

create policy affiliate_codes_gateway_select on affiliate_codes for select to auth_profile_lookup using (true);
create policy affiliate_codes_gateway_insert on affiliate_codes for insert to auth_profile_lookup with check (true);
create policy affiliate_referrals_gateway_select on affiliate_referrals for select to auth_profile_lookup using (true);
create policy affiliate_referrals_gateway_insert on affiliate_referrals for insert to auth_profile_lookup with check (true);
create policy affiliate_wallets_gateway_select on affiliate_wallets for select to auth_profile_lookup using (true);
create policy affiliate_wallets_gateway_insert on affiliate_wallets for insert to auth_profile_lookup with check (true);
create policy affiliate_wallets_gateway_update on affiliate_wallets for update to auth_profile_lookup
  using (true) with check (true);
create policy affiliate_ledger_entries_gateway_select on affiliate_ledger_entries for select to auth_profile_lookup
  using (true);
create policy affiliate_ledger_entries_gateway_insert on affiliate_ledger_entries for insert to auth_profile_lookup
  with check (true);
create policy affiliate_commissions_gateway_select on affiliate_commissions for select to auth_profile_lookup
  using (true);
-- Auditoria do vínculo: só esta ação, só sobre o perfil client recém-criado do Bureau.
create policy audit_logs_affiliate_referral_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'affiliate.referral_linked'
  and table_name = 'profiles'
  and record_id = user_id
  and support_session_id is null
  and exists (
    select 1 from profiles p
     where p.id = audit_logs.user_id and p.role = 'client' and p.bureau_id = audit_logs.bureau_id)
);

insert into settings (key, value, description) values
  ('affiliate_commission_hold_days', '30'::jsonb, 'Dias de carência da comissão de afiliado antes de ficar disponível'),
  ('affiliate_withdrawal_fee', '{"fixed": 0, "percent": 0}'::jsonb, 'Taxa de saque da comissão: valor fixo (R$) e percentual')
on conflict (key) do nothing;
