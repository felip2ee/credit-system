#!/bin/sh
# Runs the checksum-tracked, forward-only schema migrations, then starts the
# server. Migrations are idempotent — a redeploy with nothing new is a no-op.
# RUN_MIGRATIONS=0 skips them (e.g. a read-replica or a debugging container).
set -e

if [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
  echo "app-entrypoint: applying database migrations"
  # Postgres may still be starting on a fresh `docker stack deploy`; retry.
  i=1
  until node scripts/db/migrate.mjs; do
    if [ "$i" -ge "${MIGRATE_MAX_ATTEMPTS:-30}" ]; then
      echo "app-entrypoint: migrations failed after $i attempts" >&2
      exit 1
    fi
    echo "app-entrypoint: migrate attempt $i failed, retrying in 5s"
    i=$((i + 1))
    sleep 5
  done
fi

exec node server.js
