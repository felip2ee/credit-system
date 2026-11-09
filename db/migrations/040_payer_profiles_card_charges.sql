-- Pagamento por pagador (Pix e cartão). Spec: docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md.
-- 1) pix_charges guarda Pix e cartão (decisão D1 do spec): billing_type separa os dois. O nome da tabela é legado.
-- 2) payer_profiles: dados do dono da carteira (cliente ou Bureau). Documento, CEP e número ficam só cifrados em
--    pii_ciphertext (AES-256-GCM no aplicativo); as colunas *_masked guardam a forma mascarada para a tela.
-- 3) bind_pix_charge ganha os campos do parcelamento e do cartão (a assinatura de 3 argumentos sai; chamadas com 3
--    argumentos continuam válidas pelos defaults).
-- 4) set_pix_charge_customer: liga o cliente Asaas à cobrança reservada (app_runtime não atualiza pix_charges).
-- 5) lgpd_anonymize_client_account: também apaga a linha de payer_profiles do cliente.

-- 1) pix_charges: forma de pagamento, parcelas, taxa repassada, cartão (só bandeira e 4 últimos dígitos), pagador.
-- amount continua sendo o valor creditado na carteira; total_charged é o valor cobrado do pagador (nulo no Pix).
alter table pix_charges
  add column billing_type text not null default 'PIX' check (billing_type in ('PIX', 'CREDIT_CARD')),
  add column installments smallint not null default 1 check (installments between 1 and 12),
  add column fee_amount numeric(15,2) not null default 0 check (fee_amount >= 0),
  add column total_charged numeric(15,2),
  add column asaas_installment_id text check (asaas_installment_id is null or btrim(asaas_installment_id) <> ''),
  add column card_brand text check (card_brand is null or (btrim(card_brand) <> '' and length(card_brand) <= 20)),
  add column card_last4 text check (card_last4 is null or card_last4 ~ '^\d{4}$'),
  add column asaas_customer_id text
    check (asaas_customer_id is null or (btrim(asaas_customer_id) <> '' and length(asaas_customer_id) <= 100)),
  add column payer_kind text check (payer_kind is null or payer_kind in ('owner', 'other')),
  add column payer_document_masked text check (payer_document_masked is null
    or payer_document_masked ~ '^(\*\*\*\.\d{3}\.\*\*\*-\*\*|\*\*\.\d{3}\.\*\*\*/\*\*\*\*-\*\*)$');

-- Parcelas e taxa só no cartão; no Pix o total cobrado é o próprio amount (total_charged nulo). No cartão o total é o
-- valor creditado mais a taxa repassada.
alter table pix_charges add constraint pix_charges_billing_shape_check check (
  (billing_type = 'PIX' and installments = 1 and fee_amount = 0 and total_charged is null
     and asaas_installment_id is null and card_brand is null and card_last4 is null)
  or (billing_type = 'CREDIT_CARD' and (total_charged is null or total_charged = amount + fee_amount)));

create unique index pix_charges_asaas_installment_idx on pix_charges(asaas_installment_id)
  where asaas_installment_id is not null;
-- Teto de tentativas de cartão por solicitante e hora (countRecentCardAttempts).
create index pix_charges_card_attempts_idx on pix_charges(requested_by, created_at desc)
  where billing_type = 'CREDIT_CARD';

-- A reserva (reserveCharge) grava estas colunas no insert. O cliente Asaas e os campos de cartão entram depois, por
-- set_pix_charge_customer e bind_pix_charge, que rodam como auth_profile_lookup.
grant insert (billing_type, installments, fee_amount, total_charged, payer_kind, payer_document_masked)
  on pix_charges to app_runtime;
grant update (asaas_installment_id, card_brand, card_last4, asaas_customer_id) on pix_charges to auth_profile_lookup;

-- 2) payer_profiles. Uma linha por dono: client_profile_id preenchido = cliente; nulo = o Bureau (empresa).
create table payer_profiles (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  client_profile_id uuid,
  name text check (name is null or (btrim(name) <> '' and length(name) <= 200)),
  email text check (email is null or (btrim(email) <> '' and length(email) <= 254)),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Blob: versão (1 byte) + IV (12) + tag (16) + texto cifrado.
  pii_ciphertext bytea not null check (octet_length(pii_ciphertext) between 29 and 4096),
  pii_key_id text not null check (pii_key_id ~ '^[a-z0-9_-]{1,32}$'),
  document_masked text check (document_masked is null
    or document_masked ~ '^(\*\*\*\.\d{3}\.\*\*\*-\*\*|\*\*\.\d{3}\.\*\*\*/\*\*\*\*-\*\*)$'),
  postal_code_masked text check (postal_code_masked is null or postal_code_masked ~ '^\*{5}-\d{3}$'),
  has_address_number boolean not null default false,
  asaas_customer_id text
    check (asaas_customer_id is null or (btrim(asaas_customer_id) <> '' and length(asaas_customer_id) <= 100)),
  -- true = nós criamos o cliente Asaas para este dono (pode atualizar); false = adotado, nunca atualizado.
  asaas_customer_owned boolean not null default false,
  -- true = o dado mudou depois da última sincronização com o Asaas.
  asaas_customer_stale boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bureau_id, client_profile_id) references client_wallets(bureau_id, client_profile_id)
);
create unique index payer_profiles_client_idx on payer_profiles(client_profile_id) where client_profile_id is not null;
create unique index payer_profiles_bureau_idx on payer_profiles(bureau_id) where client_profile_id is null;

create trigger payer_profiles_updated_at before update on payer_profiles
  for each row execute function set_updated_at();

alter table payer_profiles owner to schema_owner;
alter table payer_profiles enable row level security;
alter table payer_profiles force row level security;
revoke all on payer_profiles from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
-- Sem delete: só a anonimização (lgpd_owner) apaga. Sem update de id, bureau_id, client_profile_id e created_at.
grant select on payer_profiles to app_runtime, backup_reader;
grant insert (bureau_id, client_profile_id, name, email, phone_e164, pii_ciphertext, pii_key_id, document_masked,
  postal_code_masked, has_address_number, asaas_customer_id, asaas_customer_owned, asaas_customer_stale)
  on payer_profiles to app_runtime;
grant update (name, email, phone_e164, pii_ciphertext, pii_key_id, document_masked, postal_code_masked,
  has_address_number, asaas_customer_id, asaas_customer_owned, asaas_customer_stale)
  on payer_profiles to app_runtime;

-- Cliente: só a própria linha. Bureau: a linha da empresa, só para o bureau_admin (quem tem wallet:topup). Equipe
-- nunca lê linha de cliente; superadmin e sessão de suporte não leem nada (a sessão de suporte recusa também o papel
-- de cliente ou de admin que a carregue).
create policy payer_profiles_select on payer_profiles for select to app_runtime using (
  coalesce(current_setting('app.support_session_id', true), '') = ''
  and ((app_context_present() and app_user_role() = 'client'
        and bureau_id = app_bureau_id() and client_profile_id = app_user_id())
    or (client_profile_id is null and bureau_id = app_bureau_id()
        and app_user_role() = 'bureau_admin' and (select app_is_staff())))
);
create policy payer_profiles_insert on payer_profiles for insert to app_runtime with check (
  coalesce(current_setting('app.support_session_id', true), '') = ''
  and ((app_context_present() and app_user_role() = 'client'
        and bureau_id = app_bureau_id() and client_profile_id = app_user_id())
    or (client_profile_id is null and bureau_id = app_bureau_id()
        and app_user_role() = 'bureau_admin' and (select app_is_staff())))
);
create policy payer_profiles_update on payer_profiles for update to app_runtime using (
  coalesce(current_setting('app.support_session_id', true), '') = ''
  and ((app_context_present() and app_user_role() = 'client'
        and bureau_id = app_bureau_id() and client_profile_id = app_user_id())
    or (client_profile_id is null and bureau_id = app_bureau_id()
        and app_user_role() = 'bureau_admin' and (select app_is_staff())))
) with check (
  coalesce(current_setting('app.support_session_id', true), '') = ''
  and ((app_context_present() and app_user_role() = 'client'
        and bureau_id = app_bureau_id() and client_profile_id = app_user_id())
    or (client_profile_id is null and bureau_id = app_bureau_id()
        and app_user_role() = 'bureau_admin' and (select app_is_staff())))
);

-- Anonimização da conta do cliente (lgpd_owner): lê e apaga só a linha do cliente do próprio Bureau.
grant select (bureau_id, client_profile_id), delete on payer_profiles to lgpd_owner;
create policy payer_profiles_lgpd_select on payer_profiles for select to lgpd_owner
  using (bureau_id = app_bureau_id() and client_profile_id is not null);
create policy payer_profiles_lgpd_delete on payer_profiles for delete to lgpd_owner
  using (bureau_id = app_bureau_id() and client_profile_id is not null);

-- 3) bind_pix_charge: nova assinatura. Pix exige o código; cartão pode ficar sem ele e ganha parcelamento, bandeira e
-- 4 últimos dígitos. Só o autor, só enquanto pendente. Repetir o mesmo pagamento é inofensivo (o webhook pode ter ligado
-- antes). No cartão, outra parcela do mesmo parcelamento também liga; os campos novos entram só se ainda forem nulos.
drop function bind_pix_charge(uuid, text, text);
create function bind_pix_charge(
  p_id uuid,
  p_payment text,
  p_payload text default null,
  p_installment text default null,
  p_brand text default null,
  p_last4 text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
  v_installment text := nullif(btrim(p_installment), '');
  v_brand text := left(nullif(btrim(p_brand), ''), 20);
  v_last4 text := case when p_last4 ~ '^\d{4}$' then p_last4 end;
begin
  if not public.app_context_present() or public.app_user_id() is null or p_id is null
     or p_payment is null or btrim(p_payment) = '' then
    return false;
  end if;
  select * into v_charge from public.pix_charges
   where id = p_id and requested_by = public.app_user_id() and bureau_id = public.app_bureau_id()
   for update;
  if v_charge.id is null or v_charge.status <> 'pending' then
    return false;
  end if;
  if v_charge.billing_type = 'PIX' and (p_payload is null or btrim(p_payload) = '') then
    return false;
  end if;
  if v_charge.asaas_payment_id is null or v_charge.asaas_payment_id = p_payment
     or (v_charge.billing_type = 'CREDIT_CARD' and v_installment is not null
         and v_charge.asaas_installment_id = v_installment) then
    update public.pix_charges
       set asaas_payment_id = coalesce(asaas_payment_id, p_payment),
           pix_payload = coalesce(pix_payload, nullif(btrim(p_payload), '')),
           asaas_installment_id = coalesce(asaas_installment_id, v_installment),
           card_brand = coalesce(card_brand, v_brand),
           card_last4 = coalesce(card_last4, v_last4)
     where id = v_charge.id;
    return true;
  end if;
  return false;
end
$$;

alter function bind_pix_charge(uuid, text, text, text, text, text) owner to auth_profile_lookup;
revoke all on function bind_pix_charge(uuid, text, text, text, text, text) from public;
grant execute on function bind_pix_charge(uuid, text, text, text, text, text) to app_runtime;

-- 4) Liga o cliente Asaas à cobrança reservada. Só o autor, só pendente. Repetir o mesmo id é inofensivo; outro id
-- recusa (devolve false): a cobrança já pertence a um cliente Asaas.
create function set_pix_charge_customer(p_id uuid, p_customer text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_charge public.pix_charges;
begin
  if not public.app_context_present() or public.app_user_id() is null or p_id is null
     or p_customer is null or btrim(p_customer) = '' or length(p_customer) > 100 then
    return false;
  end if;
  select * into v_charge from public.pix_charges
   where id = p_id and requested_by = public.app_user_id() and bureau_id = public.app_bureau_id()
   for update;
  if v_charge.id is null or v_charge.status <> 'pending' then
    return false;
  end if;
  if v_charge.asaas_customer_id is null then
    update public.pix_charges set asaas_customer_id = p_customer where id = v_charge.id;
    return true;
  end if;
  return v_charge.asaas_customer_id = p_customer;
end
$$;

alter function set_pix_charge_customer(uuid, text) owner to auth_profile_lookup;
revoke all on function set_pix_charge_customer(uuid, text) from public;
grant execute on function set_pix_charge_customer(uuid, text) to app_runtime;

-- 5) Anonimização da conta do cliente (028) + apaga payer_profiles. Corpo da 028; só o delete é novo. Dono (lgpd_owner)
-- e grants não mudam. O cliente Asaas fica no Asaas (prazo fiscal); pix_charges.payer_document_masked fica (só máscara).
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
   for no key update;
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
  -- Dados de pagamento do dono (documento, CEP e número cifrados).
  delete from public.payer_profiles where client_profile_id = p_profile_id and bureau_id = v_bureau;
  return 'ok';
end
$$;
