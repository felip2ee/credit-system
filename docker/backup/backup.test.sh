#!/usr/bin/env bash
# Harness for docker/backup: a temporary Restic LOCAL backend + a disposable
# PostgreSQL cluster, no Docker, no network.
#
# Proves:
#   1. `backup.sh` produces exactly one snapshot carrying the custom-format
#      dump, the SHA-256 manifest and the whole document tree;
#   2. `restore-test.sh` passes on that good snapshot;
#   3. `restore-test.sh` FAILS when the snapshot's dump is corrupted.
#
# DEFERRED EXECUTION: needs `restic`, `pg_dump`/`pg_restore`, `initdb`,
# `pg_ctl`, `jq` and `shuf` on PATH. The migration authoring host has none of
# restic / the postgres client suite, so this runs at the Task 15 release gate
# (same deferral as every prior DB/Docker step in this plan). It is written to
# run for real -- it never stubs or fakes a pass.
#
#   TDD note: run before backup.sh/restore-test.sh existed this fails RED at
#   step 1 (no such file); the negative case (step 3) is the RED->GREEN guard
#   for restore verification.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
for bin in restic pg_dump pg_restore initdb pg_ctl createdb psql jq shuf sha256sum; do
  command -v "$bin" >/dev/null || { echo "SKIP: '$bin' not on PATH (deferred to Task 15 gate)"; exit 127; }
done

tmp=$(mktemp -d)
cleanup() {
  pg_ctl -D "$tmp/pgdata" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# --- disposable PostgreSQL -------------------------------------------------
export PGDATA="$tmp/pgdata"
sock="$tmp/sock"; mkdir -p "$sock"
initdb -U postgres --auth=trust -E UTF8 "$PGDATA" >/dev/null
pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -k $sock" -w start >/dev/null
createdb -h "$sock" -U postgres credit_system
psql -h "$sock" -U postgres -d credit_system -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table schema_migrations (version bigint primary key, applied_at timestamptz default now());
insert into schema_migrations (version) values (1),(2),(3);
create table clientes (id serial primary key, nome text);
insert into clientes (nome) values ('alpha'),('beta');
SQL

# --- document tree ----------------------------------------------------------
docroot="$tmp/documents"; mkdir -p "$docroot/2026/01"
echo "contract one" > "$docroot/2026/01/a.pdf"
echo "contract two" > "$docroot/2026/01/b.pdf"

# --- environment for the scripts under test -------------------------------
export RESTIC_REPOSITORY="$tmp/repo"
export RESTIC_PASSWORD="test-harness-key"
export PGHOST="$sock" PGUSER=postgres PGDATABASE=credit_system
export DOCUMENT_ROOT="$docroot"
export SMTP_HOST=""                       # alert() logs only, never sends
export BACKUP_HOME="$here"
export WORK_ROOT="$tmp/work";   mkdir -p "$WORK_ROOT"
export STATE_DIR="$tmp/state"
export LOCK_DIR="$tmp/lock"
export PG_RUNAS=""                        # already unprivileged in the harness
export RESTORE_REQUIRED_TABLES="schema_migrations clientes"

restic init >/dev/null

pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
no() { echo "FAIL: $1"; fail=$((fail+1)); }

# --- 1. one snapshot, dump + manifest + documents -------------------------
sh "$here/backup.sh"
n=$(restic snapshots --json | jq 'length')
[ "$n" -eq 1 ] && ok "exactly one snapshot after backup.sh" || no "expected 1 snapshot, got $n"

listing=$(restic ls latest)
grep -q '/staging/dump.pgc$'        <<<"$listing" && ok "snapshot carries the custom-format dump" || no "dump.pgc absent from snapshot"
grep -q '/staging/manifest.sha256$' <<<"$listing" && ok "snapshot carries the SHA-256 manifest"   || no "manifest.sha256 absent from snapshot"
grep -q "$docroot/2026/01/a.pdf\$"  <<<"$listing" && ok "snapshot carries the document tree"      || no "document tree absent from snapshot"

# --- 2. restore-test green on a good snapshot -----------------------------
if sh "$here/restore-test.sh"; then ok "restore-test.sh passes on a good snapshot"
else no "restore-test.sh failed on a good snapshot"; fi

# --- 3. restore-test red when the dump is corrupted ----------------------
restic restore latest --target "$tmp/good" >/dev/null
gooddir=$(dirname "$(find "$tmp/good" -type f -name dump.pgc | head -n1)")
neg="$tmp/neg/staging"; mkdir -p "$neg"
cp "$gooddir/manifest.sha256" "$neg/manifest.sha256"     # keep the honest manifest
cp "$gooddir/meta.json" "$neg/meta.json" 2>/dev/null || echo '{}' > "$neg/meta.json"
echo "this is not a valid pg_dump" > "$neg/dump.pgc"     # ...but tamper the dump
restic backup --host reino --tag reino-daily "$neg/dump.pgc" "$neg/manifest.sha256" "$neg/meta.json" "$docroot" >/dev/null
if sh "$here/restore-test.sh"; then no "restore-test.sh passed on a corrupted dump (must fail)"
else ok "restore-test.sh correctly fails on a corrupted dump"; fi

echo "----"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
