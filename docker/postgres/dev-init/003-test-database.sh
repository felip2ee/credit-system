#!/bin/sh
# DEV ONLY. Cria o banco dedicado aos testes de integração (credit_system_test).
# Idempotente: pode rodar de novo num volume existente (veja docs/setup.md).
# Os grants por banco vêm das migrações (current_database()), não daqui.
set -eu
TEST_DB=credit_system_test
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
select format('create database %I', '$TEST_DB')
where not exists (select 1 from pg_database where datname = '$TEST_DB') \gexec
alter database $TEST_DB set app.env = 'dev';
SQL
