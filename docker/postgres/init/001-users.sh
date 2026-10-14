#!/bin/sh
# Runs ONLY ONCE, on a fresh data volume (postgres entrypoint skips it afterwards).
# If it fails on first start, roles get no password. Recovery: remove the volume
# (`docker volume rm <stack>_postgres_data`) and redeploy.
set -eu

SECRET_NAMES="schema_owner_password app_runtime_password backup_reader_password"

# Validate every secret BEFORE touching the database.
for name in $SECRET_NAMES; do
  file="/run/secrets/$name"
  if [ ! -r "$file" ]; then
    echo "required database role secret is missing or unreadable: $file" >&2
    exit 1
  fi
  if [ -z "$(cat "$file")" ]; then
    echo "required database role secret is empty: $file" >&2
    exit 1
  fi
  if [ "$(cat "$file")" = "test" ] && [ "${INIT_ALLOW_WEAK_SECRETS:-}" != "1" ]; then
    echo "weak secret 'test' rejected: $file (dev only: set INIT_ALLOW_WEAK_SECRETS=1)" >&2
    exit 1
  fi
done

# Passwords reach psql only through the environment and are pulled in with
# \getenv inside the script — never as --set argv (visible in ps) or raw SQL.
export SCHEMA_OWNER_PASSWORD="$(cat /run/secrets/schema_owner_password)"
export APP_RUNTIME_PASSWORD="$(cat /run/secrets/app_runtime_password)"
export BACKUP_READER_PASSWORD="$(cat /run/secrets/backup_reader_password)"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv schema_owner_password SCHEMA_OWNER_PASSWORD
\getenv app_runtime_password APP_RUNTIME_PASSWORD
\getenv backup_reader_password BACKUP_READER_PASSWORD

-- Keep passwords out of the server log if an ALTER ROLE fails.
set log_min_error_statement = panic;
set log_statement = 'none';

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
