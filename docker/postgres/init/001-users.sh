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

schema_owner_password=$(read_secret schema_owner_password)
app_runtime_password=$(read_secret app_runtime_password)
backup_reader_password=$(read_secret backup_reader_password)

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=schema_owner_password="$schema_owner_password" \
  --set=app_runtime_password="$app_runtime_password" \
  --set=backup_reader_password="$backup_reader_password" <<'SQL'
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
