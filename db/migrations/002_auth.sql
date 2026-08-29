-- Derived from Better Auth 1.7.2 generation with email/password and
-- twoFactor(), then adapted for case-insensitive email uniqueness/timestamptz.
create table "user" (
  id text primary key,
  name text not null,
  email text not null,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  two_factor_enabled boolean default false,
  constraint user_id_is_uuid check (id = (id::uuid)::text)
);

create unique index user_email_lower_uidx on "user" (lower(email));

create table "session" (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references "user"(id) on delete cascade
);

create index "session_userId_idx" on "session"(user_id);

create table account (
  id text primary key,
  issuer text not null,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user"(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null
);

create unique index "account_issuer_accountId_uidx"
  on account(issuer, account_id);
create index "account_userId_idx" on account(user_id);

create table verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index verification_identifier_idx on verification(identifier);

create table two_factor (
  id text primary key,
  secret text not null,
  backup_codes text not null,
  user_id text not null references "user"(id) on delete cascade,
  verified boolean default true,
  failed_verification_count integer default 0,
  locked_until timestamptz
);

create index "twoFactor_secret_idx" on two_factor(secret);
create index "twoFactor_userId_idx" on two_factor(user_id);

alter table "user" owner to schema_owner;
alter table "session" owner to schema_owner;
alter table account owner to schema_owner;
alter table verification owner to schema_owner;
alter table two_factor owner to schema_owner;
