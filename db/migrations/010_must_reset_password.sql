-- Forward-only. Imported identities carry NO legacy credential: each migrated
-- profile is created with a fresh random password and must set its own on first
-- sign-in. New profiles created by the app default to false.
alter table profiles
  add column must_reset_password boolean not null default false;
