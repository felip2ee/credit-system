do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'schema_owner') then
    create role schema_owner login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'backup_reader') then
    create role backup_reader login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'auth_profile_lookup') then
    create role auth_profile_lookup nologin;
  end if;
end
$$;

alter role schema_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
alter role app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
alter role backup_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
alter role backup_reader set default_transaction_read_only = on;
alter role auth_profile_lookup NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
grant auth_profile_lookup to schema_owner;

revoke create on schema public from public;
alter schema public owner to schema_owner;
grant usage, create on schema public to schema_owner;
grant usage on schema public to app_runtime, backup_reader, auth_profile_lookup;

do $$
begin
  execute format('revoke all on database %I from public', current_database());
  execute format(
    'grant connect on database %I to schema_owner, app_runtime, backup_reader',
    current_database()
  );
end
$$;

alter table schema_migrations owner to schema_owner;
