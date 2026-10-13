#!/bin/sh
set -eu

read_secret() {
  name="$1"
  file="/run/secrets/$name"
  if [ ! -r "$file" ]; then
    echo "required database role secret is unavailable" >&2
    exit 1
  fi

  value=$(cat "$file")
  if [ -z "$value" ]; then
    echo "required database role secret is unavailable" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# Passwords reach psql only through the environment and are pulled in with
# \getenv inside the script — never as --set argv (visible in ps) or raw SQL.
export SCHEMA_OWNER_PASSWORD="$(read_secret schema_owner_password)"
export APP_RUNTIME_PASSWORD="$(read_secret app_runtime_password)"
export BACKUP_READER_PASSWORD="$(read_secret backup_reader_password)"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv schema_owner_password SCHEMA_OWNER_PASSWORD
\getenv app_runtime_password APP_RUNTIME_PASSWORD
\getenv backup_reader_password BACKUP_READER_PASSWORD

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
end
$$;

alter role schema_owner password :'schema_owner_password';
alter role app_runtime password :'app_runtime_password';
alter role backup_reader password :'backup_reader_password';
SQL

unset SCHEMA_OWNER_PASSWORD APP_RUNTIME_PASSWORD BACKUP_READER_PASSWORD
