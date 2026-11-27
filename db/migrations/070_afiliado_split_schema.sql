-- Schema do split na entrada de dinheiro (plano afiliado-bureaus, parte 1).
-- 1) platform_partners: sócios (walletId + %). Só o superadmin lê e grava.
-- 2) bureau_referrals: bureau indicador (um por bureau indicado, sem auto-indicação e sem ciclo).
-- 3) bureau_asaas_wallets: walletId do bureau. Fica fora de `bureaus` porque essa tabela é legível por toda sessão (cliente inclusive).
-- 4) affiliate_wallets: payout_method ('asaas' | 'pix') e asaas_wallet_id. bureau_affiliate_settings: affiliate_enabled.
-- 5) charge_splits: o plano de split de cada cobrança, gravado na criação. Escrita só por funções definer (dono auth_profile_lookup).
-- 6) affiliate_ledger_entries.origin: 'order' (captura do pedido, legado) ou 'cash_in' (comissão sobre a entrada).
-- affiliate_commission_hold_days não muda aqui: a semente está na 026 (já aplicada) e o valor gravado não é reescrito.

-- Sócios.
create table platform_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  asaas_wallet_id text not null check (btrim(asaas_wallet_id) <> '' and length(asaas_wallet_id) <= 64),
  pct numeric(5,2) not null check (pct > 0 and pct <= 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Bureau indicador. referred unique: cada bureau tem no máximo um indicador.
create table bureau_referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_bureau_id uuid not null references bureaus(id),
  referred_bureau_id uuid not null unique references bureaus(id),
  pct numeric(5,2) not null default 5 check (pct >= 0 and pct <= 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint bureau_referrals_no_self_check check (referrer_bureau_id <> referred_bureau_id)
);
create index bureau_referrals_referrer_idx on bureau_referrals(referrer_bureau_id);

-- Recusa o ciclo A -> B -> ... -> A. Lê a tabela inteira (a RLS esconderia linhas), por isso é definer. O lock serializa
-- duas inserções que juntas fechariam um ciclo.
create function bureau_referrals_no_cycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('bureau_referrals_cycle'));
  if exists (
    with recursive up(b) as (
      select r.referrer_bureau_id from public.bureau_referrals r
       where r.referred_bureau_id = new.referrer_bureau_id and r.id <> new.id
      union
      select r.referrer_bureau_id from public.bureau_referrals r join up on r.referred_bureau_id = up.b
       where r.id <> new.id
    )
    select 1 from up where b = new.referred_bureau_id
  ) then
    raise exception 'a indicação entre bureaus forma um ciclo' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger bureau_referrals_no_cycle before insert or update of referrer_bureau_id, referred_bureau_id on bureau_referrals
  for each row execute function bureau_referrals_no_cycle();

-- walletId do bureau.
create table bureau_asaas_wallets (
  bureau_id uuid primary key references bureaus(id),
  asaas_wallet_id text not null check (btrim(asaas_wallet_id) <> '' and length(asaas_wallet_id) <= 64),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

-- Modo de repasse do afiliado de link.
alter table affiliate_wallets
  add column payout_method text not null default 'pix' constraint affiliate_wallets_payout_method_check check (payout_method in ('asaas', 'pix')),
  add column asaas_wallet_id text check (asaas_wallet_id is null or (btrim(asaas_wallet_id) <> '' and length(asaas_wallet_id) <= 64)),
  add constraint affiliate_wallets_asaas_wallet_check check (payout_method <> 'asaas' or asaas_wallet_id is not null);

alter table bureau_affiliate_settings add column affiliate_enabled boolean not null default false;

alter table affiliate_ledger_entries
  add column origin text not null default 'order' constraint affiliate_ledger_entries_origin_check check (origin in ('order', 'cash_in'));

-- Plano de split de uma cobrança. beneficiary_id: platform_partners.id, bureau (dono ou indicador) ou perfil do afiliado.
-- payout_method 'accrual' = bureau sem walletId (lançamento em bureau_payable_entries na confirmação).
-- Mudar walletId ou modo depois não altera a linha: ela guarda o plano do momento da criação.
alter table pix_charges add constraint pix_charges_bureau_id_id_key unique (bureau_id, id);

create table charge_splits (
  id uuid primary key default gen_random_uuid(),
  pix_charge_id uuid not null,
  bureau_id uuid not null,
  beneficiary_kind text not null constraint charge_splits_beneficiary_kind_check
    check (beneficiary_kind in ('partner', 'bureau', 'bureau_referrer', 'affiliate')),
  beneficiary_id uuid not null,
  payout_method text not null constraint charge_splits_payout_method_check check (payout_method in ('asaas', 'pix', 'accrual')),
  asaas_wallet_id text check (asaas_wallet_id is null or (btrim(asaas_wallet_id) <> '' and length(asaas_wallet_id) <= 64)),
  pct numeric(5,2) not null check (pct >= 0 and pct <= 100),
  amount_cents bigint not null check (amount_cents >= 0),
  asaas_split_id text,
  status text not null default 'pending' constraint charge_splits_status_check
    check (status in ('pending', 'done', 'refused', 'refunded', 'reversal_failed')),
  created_at timestamptz not null default now(),
  constraint charge_splits_beneficiary_key unique (pix_charge_id, beneficiary_kind, beneficiary_id),
  constraint charge_splits_asaas_wallet_check check (payout_method <> 'asaas' or asaas_wallet_id is not null),
  foreign key (bureau_id, pix_charge_id) references pix_charges(bureau_id, id)
);
create index charge_splits_bureau_created_idx on charge_splits(bureau_id, created_at desc);
create index charge_splits_split_id_idx on charge_splits(asaas_split_id) where asaas_split_id is not null;

-- Dono, RLS e grants.
alter table platform_partners owner to schema_owner;
alter table bureau_referrals owner to schema_owner;
alter table bureau_asaas_wallets owner to schema_owner;
alter table charge_splits owner to schema_owner;
alter function bureau_referrals_no_cycle() owner to auth_profile_lookup;
revoke all on function bureau_referrals_no_cycle() from public;

alter table platform_partners enable row level security;
alter table platform_partners force row level security;
alter table bureau_referrals enable row level security;
alter table bureau_referrals force row level security;
alter table bureau_asaas_wallets enable row level security;
alter table bureau_asaas_wallets force row level security;
alter table charge_splits enable row level security;
alter table charge_splits force row level security;

-- Sócios: só o superadmin (sem sessão de suporte).
create policy platform_partners_superadmin on platform_partners for all
  using (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
  with check (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null);

-- Indicação entre bureaus: o superadmin lê e grava; a equipe do bureau indicador lê as próprias linhas.
create policy bureau_referrals_select on bureau_referrals for select using (
  app_context_present() and (
    (app_user_role() = 'superadmin' and app_support_session_id() is null)
    or (referrer_bureau_id = app_bureau_id() and (select app_is_staff())))
);
create policy bureau_referrals_superadmin_write on bureau_referrals for all
  using (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
  with check (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null);

-- walletId do bureau: a equipe do bureau lê o próprio; só o superadmin grava.
create policy bureau_asaas_wallets_select on bureau_asaas_wallets for select using (
  app_context_present() and (
    (app_user_role() = 'superadmin' and app_support_session_id() is null)
    or (bureau_id = app_bureau_id() and (select app_is_staff())))
);
create policy bureau_asaas_wallets_superadmin_write on bureau_asaas_wallets for all
  using (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null)
  with check (app_context_present() and app_user_role() = 'superadmin' and app_support_session_id() is null);

-- charge_splits: a equipe lê as linhas do próprio bureau, menos as dos sócios; o superadmin lê todas.
create policy charge_splits_select on charge_splits for select using (
  app_context_present() and (
    (app_user_role() = 'superadmin' and app_support_session_id() is null)
    or (bureau_id = app_bureau_id() and beneficiary_kind <> 'partner' and (select app_is_staff())))
);

revoke all on platform_partners, bureau_referrals, bureau_asaas_wallets, charge_splits
  from public, app_runtime, auth_profile_lookup;
grant select, insert, update on platform_partners, bureau_referrals, bureau_asaas_wallets to app_runtime;
grant select on charge_splits to app_runtime;
grant select on platform_partners, bureau_referrals, bureau_asaas_wallets, charge_splits to backup_reader;

-- Funções definer (dono auth_profile_lookup) leem os quatro e gravam charge_splits.
grant select on platform_partners, bureau_referrals, bureau_asaas_wallets to auth_profile_lookup;
grant select, insert, update (status, asaas_split_id) on charge_splits to auth_profile_lookup;
create policy platform_partners_gateway_select on platform_partners for select to auth_profile_lookup using (true);
create policy bureau_referrals_gateway_select on bureau_referrals for select to auth_profile_lookup using (true);
create policy bureau_asaas_wallets_gateway_select on bureau_asaas_wallets for select to auth_profile_lookup using (true);
create policy charge_splits_gateway_select on charge_splits for select to auth_profile_lookup using (true);
create policy charge_splits_gateway_insert on charge_splits for insert to auth_profile_lookup with check (true);
create policy charge_splits_gateway_update on charge_splits for update to auth_profile_lookup using (true) with check (true);
