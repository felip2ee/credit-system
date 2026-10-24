-- Programa de afiliados, saque e conversão.
-- 1) affiliate_withdrawals: um pedido de saque da comissão. Um aberto por afiliado (índice único parcial). A chave PIX é
--    gravada só aqui; o app_runtime não lê a tabela: o cliente lê pela função que mascara a chave e o superadmin pelo
--    detalhe (que audita cada leitura). Nenhuma auditoria leva a chave.
-- 2) request_affiliate_withdrawal (cliente), mark_affiliate_withdrawal_paid e cancel_affiliate_withdrawal (superadmin fora
--    de suporte), convert_affiliate_commission (cliente). Dinheiro só por affiliate_wallet_post_entry; a auditoria nasce na
--    mesma transação.
-- 3) lgpd_anonymize_client_account (027): saque aberto ou comissão disponível bloqueiam a anonimização ('commission').
--    A comissão ainda em carência é perdida na anonimização (affiliate_forfeit_pending): reversão de cada comissão
--    pendente, auditoria affiliate.forfeit sem documento.
-- 4) affiliate_withdrawal_fee: a taxa de saque para o cliente (a tabela settings não é visível a ele).
-- Ordem de travas: carteira do afiliado -> comissões dele -> carteira de créditos. Pagar e cancelar travam o saque e depois
-- a carteira; o pedido não trava o saque aberto de ninguém, então as duas ordens não se cruzam.

-- Formato da chave PIX por tipo. A action normaliza antes (documento só dígitos, telefone E.164, UUID minúsculo); aqui
-- a tabela se defende de quem escreve por outro caminho.
create function affiliate_pix_key_valid(p_type text, p_key text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(case p_type
    when 'document' then p_key ~ '^([0-9]{11}|[0-9]{14})$'
    when 'email' then p_key ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    when 'phone' then p_key ~ '^\+[1-9][0-9]{7,14}$'
    when 'random' then p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    else false
  end, false)
$$;

create table affiliate_withdrawals (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  profile_id uuid not null references profiles(id),
  amount numeric(15,2) not null check (amount > 0 and amount <= 99999999.99),
  fee numeric(15,2) not null check (fee >= 0),
  net numeric(15,2) not null check (net > 0),
  pix_key_type text not null check (pix_key_type in ('document', 'email', 'phone', 'random')),
  pix_key text not null check (btrim(pix_key) <> '' and length(pix_key) <= 200),
  holder_name text not null check (btrim(holder_name) <> ''),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  cancel_reason text,
  receipt_object_key text,
  receipt_mime text,
  receipt_sha256 text,
  paid_at timestamptz,
  paid_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  foreign key (bureau_id, profile_id) references profiles(bureau_id, id),
  constraint affiliate_withdrawals_net check (net = amount - fee),
  constraint affiliate_withdrawals_pix_key_format check (affiliate_pix_key_valid(pix_key_type, pix_key)),
  -- Pago exige as cinco colunas; fora de pago nenhuma delas existe (padrão de payouts, 016).
  constraint affiliate_withdrawals_paid_complete check (
    (status = 'paid') = (
      paid_at is not null and paid_by is not null and receipt_object_key is not null
      and receipt_mime is not null and receipt_sha256 is not null
    )
  ),
  constraint affiliate_withdrawals_unpaid_clean check (
    status = 'paid' or (
      paid_at is null and paid_by is null and receipt_object_key is null
      and receipt_mime is null and receipt_sha256 is null
    )
  ),
  constraint affiliate_withdrawals_receipt_format check (
    receipt_object_key is null or (
      btrim(receipt_object_key) <> '' and length(receipt_object_key) <= 500
      and receipt_mime in ('application/pdf', 'image/png', 'image/jpeg')
      and receipt_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  -- Cancelado exige o motivo; fora de cancelado ele não existe.
  constraint affiliate_withdrawals_cancel_reason check (
    (status = 'cancelled') = (cancel_reason is not null)
    and (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 500))
  )
);

create unique index affiliate_withdrawals_open_idx on affiliate_withdrawals(profile_id) where status = 'open';
create index affiliate_withdrawals_profile_idx on affiliate_withdrawals(profile_id, created_at desc);
create index affiliate_withdrawals_status_idx on affiliate_withdrawals(status, created_at);

-- Saque: só open -> paid | cancelled, e só nas colunas de pagamento. Nada se apaga.
create function affiliate_withdrawals_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'open'
     and new.status in ('paid', 'cancelled')
     and (to_jsonb(new) - 'status' - 'cancel_reason' - 'paid_at' - 'paid_by' - 'receipt_object_key' - 'receipt_mime' - 'receipt_sha256')
         = (to_jsonb(old) - 'status' - 'cancel_reason' - 'paid_at' - 'paid_by' - 'receipt_object_key' - 'receipt_mime' - 'receipt_sha256') then
    return new;
  end if;
  raise exception 'affiliate_withdrawals allows only the open transitions' using errcode = 'check_violation';
end
$$;

create trigger affiliate_withdrawals_guard before update or delete on affiliate_withdrawals
  for each row execute function affiliate_withdrawals_guard();
create trigger affiliate_withdrawals_no_truncate before truncate on affiliate_withdrawals
  for each statement execute function affiliate_withdrawals_guard();

-- Chave PIX para o cliente e para a fila: só o suficiente para reconhecer a própria chave.
create function affiliate_mask_pix_key(p_type text, p_key text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_type
    when 'email' then left(p_key, 1) || '***' || substr(p_key, position('@' in p_key))
    when 'phone' then '***' || right(p_key, 4)
    when 'document' then '***' || right(p_key, 2)
    else '***' || right(p_key, 4)
  end
$$;

-- Taxa de saque (fixo e %) para qualquer usuário autenticado: a tabela settings não é visível ao cliente por RLS, e esta
-- função expõe só esta chave. Valor ausente ou malformado vale 0. É a mesma leitura que o pedido de saque usa para cobrar.
create function affiliate_withdrawal_fee()
returns table (fixed numeric, percent numeric)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_config jsonb;
  v_fixed numeric := 0;
  v_percent numeric := 0;
begin
  if not public.app_context_present() then
    return;
  end if;
  select value into v_config from public.settings where key = 'affiliate_withdrawal_fee';
  if jsonb_typeof(v_config -> 'fixed') = 'number' then
    v_fixed := greatest((v_config ->> 'fixed')::numeric, 0);
  end if;
  if jsonb_typeof(v_config -> 'percent') = 'number' then
    v_percent := greatest((v_config ->> 'percent')::numeric, 0);
  end if;
  return query select v_fixed, v_percent;
end
$$;

-- Pedido de saque. Trava a carteira antes de tudo: dois pedidos do mesmo afiliado, ou um pedido e uma conversão, se
-- enfileiram e o segundo enxerga o saldo e o saque aberto do primeiro. A taxa fica com a plataforma.
create function request_affiliate_withdrawal(p_amount numeric, p_pix_key_type text, p_pix_key text)
returns table (ok boolean, reason text, withdrawal_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_user uuid := public.app_user_id();
  v_bureau uuid := public.app_bureau_id();
  v_name text;
  v_key text := btrim(p_pix_key);
  v_fixed numeric;
  v_percent numeric;
  v_fee numeric;
  v_net numeric;
  v_id uuid := gen_random_uuid();
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'client'
     or public.app_support_session_id() is not null
     or v_user is null or v_bureau is null then
    return query select false, 'not_allowed'::text, null::uuid;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text, null::uuid;
    return;
  end if;
  if p_pix_key_type is null or p_pix_key_type not in ('document', 'email', 'phone', 'random')
     or v_key is null or length(v_key) > 200 or not public.affiliate_pix_key_valid(p_pix_key_type, v_key) then
    return query select false, 'invalid_pix_key'::text, null::uuid;
    return;
  end if;

  select p.full_name into v_name from public.profiles p
   where p.id = v_user and p.role = 'client' and p.bureau_id = v_bureau and p.anonymized_at is null;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;
  perform 1 from public.affiliate_wallets w where w.profile_id = v_user and w.bureau_id = v_bureau for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid;
    return;
  end if;

  -- Chave CPF/CNPJ: só o documento do titular ligado à conta (o registro do cliente). Chave de terceiro não sai.
  if p_pix_key_type = 'document' and not exists (
       select 1 from public.holders h
        where h.client_profile_id = v_user and h.bureau_id = v_bureau and h.document_digits = v_key) then
    return query select false, 'pix_key_not_owner'::text, null::uuid;
    return;
  end if;

  select f.fixed, f.percent into v_fixed, v_percent from public.affiliate_withdrawal_fee() f;
  v_fee := round(v_fixed + v_percent * p_amount / 100, 2);
  v_net := p_amount - v_fee;
  if v_net <= 0 then
    return query select false, 'net_not_positive'::text, null::uuid;
    return;
  end if;

  if exists (select 1 from public.affiliate_withdrawals w where w.profile_id = v_user and w.status = 'open') then
    return query select false, 'withdrawal_open'::text, null::uuid;
    return;
  end if;

  -- A reserva vem antes do INSERT: se a carteira recusar, nada foi escrito.
  select * into v_post from public.affiliate_wallet_post_entry(
    v_user, 'withdrawal_hold', p_amount, 'withdrawal_hold:' || v_id::text, 'withdrawal:' || v_id::text, v_user);
  if not v_post.ok then
    return query select false, v_post.reason, null::uuid;
    return;
  end if;

  insert into public.affiliate_withdrawals (id, bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key, holder_name)
  values (v_id, v_bureau, v_user, p_amount, v_fee, v_net, p_pix_key_type, v_key, v_name);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user, 'withdrawal.request', 'affiliate_withdrawals', v_id,
    jsonb_build_object('amount', p_amount::text, 'fee', v_fee::text, 'net', v_net::text, 'pix_key_type', p_pix_key_type));

  return query select true, null::text, v_id;
end
$$;

-- Conversão em créditos, sem taxa. Idempotente por p_request_id. Trava a carteira de comissão e depois a de créditos.
create function convert_affiliate_commission(p_amount numeric, p_request_id uuid)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_user uuid := public.app_user_id();
  v_bureau uuid := public.app_bureau_id();
  v_post record;
  v_credit record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'client'
     or public.app_support_session_id() is not null
     or v_user is null or v_bureau is null then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_request_id is null then
    return query select false, 'invalid_request'::text;
    return;
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount <= 0 or p_amount > 99999999.99 then
    return query select false, 'invalid_amount'::text;
    return;
  end if;
  if not exists (select 1 from public.profiles p
                  where p.id = v_user and p.role = 'client' and p.bureau_id = v_bureau and p.anonymized_at is null) then
    return query select false, 'not_found'::text;
    return;
  end if;

  select * into v_post from public.affiliate_wallet_post_entry(
    v_user, 'conversion', p_amount, 'conversion:' || p_request_id::text, 'conversion:' || p_request_id::text, v_user);
  if not v_post.ok then
    return query select false, v_post.reason;
    return;
  end if;
  if v_post.replayed then
    return query select true, null::text;
    return;
  end if;

  select * into v_credit from public.client_wallet_post_entry(
    v_user, 'commission_credit', p_amount, 'commission_credit:' || p_request_id::text,
    'conversion:' || p_request_id::text, null, v_user);
  if not v_credit.ok then
    -- A transação inteira volta: nunca fica o débito da comissão sem o crédito.
    raise exception 'client wallet refused the commission credit: %', v_credit.reason;
  end if;

  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user, 'affiliate.conversion', 'affiliate_ledger_entries', v_post.entry_id,
    jsonb_build_object('amount', p_amount::text));
  return query select true, null::text;
end
$$;

-- Marca como pago: exige saque aberto e comprovante completo. Repetir com o mesmo comprovante (sha256) devolve ok sem
-- gravar de novo (replayed = true: o objeto novo é redundante); outro comprovante devolve already_paid.
create function mark_affiliate_withdrawal_paid(p_id uuid, p_object_key text, p_mime text, p_sha256 text)
returns table (ok boolean, reason text, status text, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_w public.affiliate_withdrawals;
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::text, false;
    return;
  end if;

  select * into v_w from public.affiliate_withdrawals w where w.id = p_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text, false;
    return;
  end if;
  if v_w.status = 'cancelled' then
    return query select false, 'invalid_state'::text, v_w.status, false;
    return;
  end if;
  if v_w.status = 'paid' then
    if v_w.receipt_sha256 is not distinct from p_sha256 then
      return query select true, null::text, v_w.status, true;
    else
      return query select false, 'already_paid'::text, v_w.status, false;
    end if;
    return;
  end if;
  if p_object_key is null or btrim(p_object_key) = '' or length(p_object_key) > 500
     or p_mime is null or p_mime not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    return query select false, 'invalid_receipt'::text, v_w.status, false;
    return;
  end if;

  select * into v_post from public.affiliate_wallet_post_entry(
    v_w.profile_id, 'withdrawal_paid', v_w.amount, 'withdrawal_paid:' || v_w.id::text, 'withdrawal:' || v_w.id::text,
    public.app_user_id());
  if not v_post.ok then
    raise exception 'affiliate wallet refused the withdrawal baixa: %', v_post.reason;
  end if;
  update public.affiliate_withdrawals
     set status = 'paid', paid_at = now(), paid_by = public.app_user_id(),
         receipt_object_key = p_object_key, receipt_mime = p_mime, receipt_sha256 = p_sha256
   where id = v_w.id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_w.bureau_id, public.app_user_id(), 'withdrawal.paid', 'affiliate_withdrawals', v_w.id,
    jsonb_build_object('amount', v_w.amount::text, 'fee', v_w.fee::text, 'net', v_w.net::text));

  return query select true, null::text, 'paid'::text, false;
end
$$;

-- Cancela um saque aberto e devolve o valor ao disponível. Repetir um cancelamento já feito devolve ok.
create function cancel_affiliate_withdrawal(p_id uuid, p_reason text)
returns table (ok boolean, reason text, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_w public.affiliate_withdrawals;
  v_post record;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::text;
    return;
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(btrim(p_reason)) > 500 then
    return query select false, 'invalid_reason'::text, null::text;
    return;
  end if;

  select * into v_w from public.affiliate_withdrawals w where w.id = p_id for update;
  if not found then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
  if v_w.status = 'cancelled' then
    return query select true, null::text, v_w.status;
    return;
  end if;
  if v_w.status = 'paid' then
    return query select false, 'invalid_state'::text, v_w.status;
    return;
  end if;

  select * into v_post from public.affiliate_wallet_post_entry(
    v_w.profile_id, 'withdrawal_release', v_w.amount, 'withdrawal_release:' || v_w.id::text, 'withdrawal:' || v_w.id::text,
    public.app_user_id());
  if not v_post.ok then
    raise exception 'affiliate wallet refused the withdrawal release: %', v_post.reason;
  end if;
  update public.affiliate_withdrawals set status = 'cancelled', cancel_reason = btrim(p_reason) where id = v_w.id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_w.bureau_id, public.app_user_id(), 'withdrawal.cancel', 'affiliate_withdrawals', v_w.id,
    jsonb_build_object('amount', v_w.amount::text));

  return query select true, null::text, 'cancelled'::text;
end
$$;

-- Detalhe do superadmin (fora de suporte): chave completa e nome do favorecido, porque é com eles que ele paga.
-- Cada leitura grava withdrawal.view; o metadata não leva a chave.
create function get_affiliate_withdrawal_detail(p_id uuid)
returns table (id uuid, bureau_id uuid, profile_id uuid, amount numeric, fee numeric, net numeric, pix_key_type text,
  pix_key text, holder_name text, account_document_masked text, status text, cancel_reason text,
  receipt_object_key text, receipt_mime text, paid_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_w public.affiliate_withdrawals;
  v_document text;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return;
  end if;

  select * into v_w from public.affiliate_withdrawals w where w.id = p_id;
  if not found then
    return;
  end if;
  -- Documento da conta, só mascarado: o superadmin confere uma chave de outro tipo contra o nome do favorecido.
  select public.affiliate_mask_pix_key('document', h.document_digits) into v_document
    from public.holders h
   where h.client_profile_id = v_w.profile_id and h.bureau_id = v_w.bureau_id and h.document_digits is not null
   order by h.created_at, h.id
   limit 1;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_w.bureau_id, public.app_user_id(), 'withdrawal.view', 'affiliate_withdrawals', v_w.id,
    jsonb_build_object('status', v_w.status));

  return query select v_w.id, v_w.bureau_id, v_w.profile_id, v_w.amount, v_w.fee, v_w.net, v_w.pix_key_type, v_w.pix_key,
    v_w.holder_name, v_document, v_w.status, v_w.cancel_reason, v_w.receipt_object_key, v_w.receipt_mime, v_w.paid_at, v_w.created_at;
end
$$;

-- Fila do superadmin (fora de suporte): chave mascarada; a completa só no detalhe. p_status nulo traz todos.
create function list_affiliate_withdrawal_queue(p_status text default 'open', p_limit integer default 100)
returns table (id uuid, bureau_id uuid, profile_id uuid, amount numeric, fee numeric, net numeric, pix_key_type text,
  pix_key_masked text, holder_name text, status text, created_at timestamptz, paid_at timestamptz)
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
    select w.id, w.bureau_id, w.profile_id, w.amount, w.fee, w.net, w.pix_key_type,
           public.affiliate_mask_pix_key(w.pix_key_type, w.pix_key), w.holder_name, w.status, w.created_at, w.paid_at
      from public.affiliate_withdrawals w
     where p_status is null or w.status = p_status
     order by w.created_at, w.id
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$$;

-- Saques do próprio afiliado, com a chave mascarada.
create function list_my_affiliate_withdrawals()
returns table (id uuid, amount numeric, fee numeric, net numeric, pix_key_type text, pix_key_masked text,
  status text, cancel_reason text, created_at timestamptz, paid_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client' then
    return;
  end if;
  return query
    select w.id, w.amount, w.fee, w.net, w.pix_key_type, public.affiliate_mask_pix_key(w.pix_key_type, w.pix_key),
           w.status, w.cancel_reason, w.created_at, w.paid_at
      from public.affiliate_withdrawals w
     where w.profile_id = public.app_user_id() and w.bureau_id = public.app_bureau_id()
     order by w.created_at desc, w.id
     limit 100;
end
$$;

-- Dono, revoke e grant.
alter table affiliate_withdrawals owner to schema_owner;
alter function affiliate_withdrawals_guard() owner to schema_owner;
alter function affiliate_mask_pix_key(text, text) owner to schema_owner;
alter function affiliate_pix_key_valid(text, text) owner to schema_owner;
alter function affiliate_withdrawal_fee() owner to auth_profile_lookup;
alter function request_affiliate_withdrawal(numeric, text, text) owner to auth_profile_lookup;
alter function convert_affiliate_commission(numeric, uuid) owner to auth_profile_lookup;
alter function mark_affiliate_withdrawal_paid(uuid, text, text, text) owner to auth_profile_lookup;
alter function cancel_affiliate_withdrawal(uuid, text) owner to auth_profile_lookup;
alter function get_affiliate_withdrawal_detail(uuid) owner to auth_profile_lookup;
alter function list_affiliate_withdrawal_queue(text, integer) owner to auth_profile_lookup;
alter function list_my_affiliate_withdrawals() owner to auth_profile_lookup;

revoke all on function affiliate_withdrawals_guard() from public;
revoke all on function affiliate_mask_pix_key(text, text) from public;
revoke all on function affiliate_pix_key_valid(text, text) from public;
revoke all on function affiliate_withdrawal_fee() from public;
revoke all on function request_affiliate_withdrawal(numeric, text, text) from public;
revoke all on function convert_affiliate_commission(numeric, uuid) from public;
revoke all on function mark_affiliate_withdrawal_paid(uuid, text, text, text) from public;
revoke all on function cancel_affiliate_withdrawal(uuid, text) from public;
revoke all on function get_affiliate_withdrawal_detail(uuid) from public;
revoke all on function list_affiliate_withdrawal_queue(text, integer) from public;
revoke all on function list_my_affiliate_withdrawals() from public;
grant execute on function affiliate_mask_pix_key(text, text) to auth_profile_lookup;
grant execute on function affiliate_pix_key_valid(text, text) to auth_profile_lookup;
grant execute on function affiliate_withdrawal_fee() to app_runtime;
grant execute on function request_affiliate_withdrawal(numeric, text, text) to app_runtime;
grant execute on function convert_affiliate_commission(numeric, uuid) to app_runtime;
grant execute on function mark_affiliate_withdrawal_paid(uuid, text, text, text) to app_runtime;
grant execute on function cancel_affiliate_withdrawal(uuid, text) to app_runtime;
grant execute on function get_affiliate_withdrawal_detail(uuid) to app_runtime;
grant execute on function list_affiliate_withdrawal_queue(text, integer) to app_runtime;
grant execute on function list_my_affiliate_withdrawals() to app_runtime;

alter table affiliate_withdrawals enable row level security;
alter table affiliate_withdrawals force row level security;

-- O app_runtime não lê nem escreve a tabela: a chave PIX só sai pelas funções acima.
revoke all on affiliate_withdrawals from public, app_runtime, auth_profile_lookup;
grant select on affiliate_withdrawals to backup_reader;

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select, insert (id, bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key, holder_name),
  update (status, cancel_reason, paid_at, paid_by, receipt_object_key, receipt_mime, receipt_sha256)
  on affiliate_withdrawals to auth_profile_lookup;
create policy affiliate_withdrawals_gateway_select on affiliate_withdrawals for select to auth_profile_lookup using (true);
create policy affiliate_withdrawals_gateway_insert on affiliate_withdrawals for insert to auth_profile_lookup
  with check (status = 'open');
-- using (true): SELECT ... FOR UPDATE também passa por esta política e precisa enxergar o saque já pago ou cancelado
-- (a repetição idempotente). As transições válidas ficam por conta do gatilho affiliate_withdrawals_guard.
create policy affiliate_withdrawals_gateway_update on affiliate_withdrawals for update to auth_profile_lookup
  using (true) with check (status in ('paid', 'cancelled'));

-- O documento do titular da conta: a conferência da chave CPF/CNPJ e a máscara no detalhe do superadmin.
grant select (document_digits) on public.holders to auth_profile_lookup;

-- A taxa de saque (a de carência já vinha da 027).
create policy settings_gateway_affiliate_fee on settings for select to auth_profile_lookup
  using (key = 'affiliate_withdrawal_fee');

-- Auditoria do saque e da conversão: só estas ações, sobre uma linha do mesmo Bureau, pelo usuário do contexto.
-- O metadata nunca leva a chave PIX.
create policy audit_logs_affiliate_withdrawal_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('withdrawal.request', 'withdrawal.view', 'withdrawal.paid', 'withdrawal.cancel')
  and table_name = 'affiliate_withdrawals'
  and support_session_id is null
  and user_id = app_user_id()
  and bureau_id is not null
  and exists (
    select 1 from affiliate_withdrawals w
     where w.id = audit_logs.record_id and w.bureau_id = audit_logs.bureau_id)
);
create policy audit_logs_affiliate_conversion_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'affiliate.conversion'
  and table_name = 'affiliate_ledger_entries'
  and support_session_id is null
  and user_id = app_user_id()
  and bureau_id is not null
  and exists (
    select 1 from affiliate_ledger_entries e
     where e.id = audit_logs.record_id and e.bureau_id = audit_logs.bureau_id and e.profile_id = audit_logs.user_id)
);

-- A LGPD lê o saque aberto do Bureau do contexto.
grant select (profile_id, bureau_id, status) on public.affiliate_withdrawals to lgpd_owner;
create policy affiliate_withdrawals_lgpd_select on affiliate_withdrawals for select to lgpd_owner
  using (bureau_id = app_bureau_id());

-- Anonimização: a comissão ainda em carência é perdida (decisão do designer; validar com o jurídico). Trava a carteira
-- do afiliado primeiro (a ordem do estorno e da liberação), recusa se ainda há comissão disponível ou saque aberto e,
-- senão, reverte cada comissão pendente: lançamento commission_reversal (chave lgpd:<comissão>), status 'reversed' e
-- auditoria affiliate.forfeit só com o valor. Devolve false quando bloqueia; nada foi escrito nesse caso. Só a função
-- de anonimização (lgpd_owner) a executa, e só para um bureau_admin do Bureau do contexto.
create function affiliate_forfeit_pending(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid := public.app_bureau_id();
  v_commission record;
  v_post record;
begin
  if v_bureau is null or public.app_user_role() is distinct from 'bureau_admin' then
    return false;
  end if;

  perform 1 from public.affiliate_wallets w where w.profile_id = p_profile_id and w.bureau_id = v_bureau for update;
  if not found then
    return true;
  end if;
  if exists (select 1 from public.affiliate_wallets w where w.profile_id = p_profile_id and w.available > 0)
     or exists (select 1 from public.affiliate_withdrawals w
                 where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.status = 'open') then
    return false;
  end if;

  for v_commission in
    select c.id, c.bureau_id, c.amount - c.reversed_amount as rest
      from public.affiliate_commissions c
     where c.affiliate_profile_id = p_profile_id and c.bureau_id = v_bureau and c.status = 'pending'
     order by c.id
       for update
  loop
    if v_commission.rest > 0 then
      select * into v_post from public.affiliate_wallet_post_entry(
        p_profile_id, 'commission_reversal', v_commission.rest, 'lgpd:' || v_commission.id::text,
        'commission:' || v_commission.id::text, p_profile_id);
      if not v_post.ok then
        raise exception 'affiliate commission forfeit failed: %', v_post.reason;
      end if;
    end if;
    update public.affiliate_commissions set reversed_amount = amount, status = 'reversed' where id = v_commission.id;
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (v_commission.bureau_id, public.app_user_id(), 'affiliate.forfeit', 'affiliate_commissions',
      v_commission.id, jsonb_build_object('amount', v_commission.rest::text));
  end loop;
  return true;
end
$$;

alter function affiliate_forfeit_pending(uuid) owner to auth_profile_lookup;
revoke all on function affiliate_forfeit_pending(uuid) from public, app_runtime;
grant execute on function affiliate_forfeit_pending(uuid) to lgpd_owner;

-- LGPD (027): comissão disponível ou saque aberto bloqueiam a anonimização da conta; a comissão pendente é perdida
-- (affiliate_forfeit_pending, que repete a checagem sob a trava da carteira). Dono e grants não mudam. O perfil fica
-- travado "for update" desde o início: a captura de pedido (capture_order) lê o perfil do afiliado "for share" e espera.
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
  if exists (select 1 from public.affiliate_wallets w
              where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.available > 0)
     or exists (select 1 from public.affiliate_withdrawals w
                 where w.profile_id = p_profile_id and w.bureau_id = v_bureau and w.status = 'open') then
    return 'commission';
  end if;
  if exists (select 1 from public.dossier_orders o
              where o.client_profile_id = p_profile_id and o.bureau_id = v_bureau
                and o.state not in ('completed', 'released', 'cancelled', 'failed')) then
    return 'open_orders';
  end if;
  -- Última checagem, já sob a trava da carteira do afiliado: perde a comissão pendente ou devolve 'commission'.
  if not public.affiliate_forfeit_pending(p_profile_id) then
    return 'commission';
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
