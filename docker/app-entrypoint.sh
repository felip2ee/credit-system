#!/bin/sh
# Waits until the one-shot `migrate` service has applied every migration, then
# starts the server. The app role (DATABASE_URL) only reads schema_migrations.
set -e

i=1
until node scripts/db/migrate.mjs --check; do
  if [ "$i" -ge "${MIGRATE_MAX_ATTEMPTS:-30}" ]; then
    echo "app-entrypoint: schema is not current after $i attempts" >&2
    exit 1
  fi
  echo "app-entrypoint: schema not ready (attempt $i), retrying in 5s"
  i=$((i + 1))
  sleep 5
done

exec node server.js
