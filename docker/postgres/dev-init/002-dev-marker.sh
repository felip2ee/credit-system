#!/bin/sh
# DEV ONLY. Marks the dev database so scripts/db/reset.mjs can refuse to drop
# any other database. Mounted by docker-compose.dev.yml only, never by docker-stack.yml.
set -eu
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "alter database credit_system set app.env = 'dev'"
