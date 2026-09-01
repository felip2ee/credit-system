#!/bin/sh
# Monthly restore drill.
#
# Restore the latest snapshot into a throwaway PostgreSQL cluster and an empty
# directory, verify every manifest hash, pg_restore, check required tables and
# row counts, re-hash a sample of documents, then email the result. The email
# carries only the snapshot id, counts and the drill duration -- no secrets,
# no PII.
set -eu

WORK_ROOT="${WORK_ROOT:-/work}"
DOCUMENT_ROOT="${DOCUMENT_ROOT:-/var/lib/reino/documents}"
REQUIRED_TABLES="${RESTORE_REQUIRED_TABLES:-schema_migrations}"
SAMPLE_SIZE="${RESTORE_SAMPLE_SIZE:-5}"
# Prefix for every command that touches the throwaway cluster. initdb/postgres
# refuse to run as root, so in the container this drops to "postgres"; the test
# harness overrides it to empty.
PG_RUNAS="${PG_RUNAS:-su-exec postgres}"

read_file_env() {
  eval "_v=\${$1:-}"; eval "_f=\${${1}_FILE:-}"
  if [ -z "$_v" ] && [ -n "$_f" ] && [ -r "$_f" ]; then
    _v=$(cat "$_f"); export "$1=$_v"
  fi
}

load_secrets() {
  read_file_env RESTIC_PASSWORD
  read_file_env AWS_ACCESS_KEY_ID
  read_file_env AWS_SECRET_ACCESS_KEY
  read_file_env SMTP_PASS
}

alert() {
  _subject="$1"; _body="$2"
  printf '[%s] %s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_subject" "$_body"
  [ -n "${SMTP_HOST:-}" ] && [ -n "${BACKUP_ALERT_TO:-}" ] || return 0
  _scheme=smtps; [ "${SMTP_SECURE:-true}" = "true" ] || _scheme=smtp
  # Credentials go in a 0600 netrc file on tmpfs, never on the curl argv
  # (argv is world-readable via /proc/<pid>/cmdline in the PID namespace).
  ( umask 077; _nrc=$(mktemp)
    printf 'machine %s login %s password %s\n' "$SMTP_HOST" "${SMTP_USER:-}" "${SMTP_PASS:-}" > "$_nrc"
    printf 'From: %s\nTo: %s\nSubject: %s\nDate: %s\n\n%s\n' \
      "${SMTP_FROM:-${SMTP_USER:-backup}}" "$BACKUP_ALERT_TO" "$_subject" \
      "$(date -R 2>/dev/null || date)" "$_body" \
    | curl -sS --ssl-reqd --netrc-file "$_nrc" \
        --url "$_scheme://${SMTP_HOST}:${SMTP_PORT:-465}" \
        --mail-from "${SMTP_USER:-backup}" --mail-rcpt "$BACKUP_ALERT_TO" --upload-file - \
      || printf 'WARN: alert email failed to send (result still logged above)\n'
    rm -f "$_nrc" )
}

SNAP=unknown
START=$(date +%s)

cleanup() {
  [ -n "${PGDATA:-}" ] && [ -d "${PGDATA:-/nonexistent}" ] && \
    $PG_RUNAS pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "${WORK:-}"
}

fail() {
  _el=$(( $(date +%s) - START ))
  alert "reino restore-test FAILED ($SNAP)" "$1 -- drill aborted after ${_el}s."
  exit 1
}

main() {
  load_secrets
  mkdir -p "$WORK_ROOT"
  WORK=$(mktemp -d "$WORK_ROOT/restore.XXXXXX")
  trap cleanup EXIT INT TERM

  PGDATA="$WORK/pgdata"
  SOCK="$WORK/sock"
  RESTORED="$WORK/restored"
  mkdir -p "$SOCK" "$RESTORED"

  SNAP=$(restic snapshots --latest 1 --json | jq -r '.[-1].short_id // "unknown"')
  [ "$SNAP" != "unknown" ] || fail "no snapshot found to restore"

  restic restore latest --target "$RESTORED" || fail "restic restore failed"
  chmod -R a+rX "$RESTORED" 2>/dev/null || true

  DUMP=$(find "$RESTORED" -type f -name dump.pgc | head -n1)
  [ -n "$DUMP" ] || fail "restored snapshot has no dump.pgc"
  STAGE=$(dirname "$DUMP")
  MANIFEST="$STAGE/manifest.sha256"
  [ -f "$MANIFEST" ] || fail "restored snapshot has no manifest.sha256"
  DOCS="$RESTORED$DOCUMENT_ROOT"

  # 1. verify manifest hashes
  ( cd "$STAGE" && grep ' dump.pgc$' manifest.sha256 | sha256sum -c - ) \
    || fail "dump hash does not match the manifest"
  if [ -d "$DOCS" ]; then
    ( cd "$DOCS" && grep -v ' dump.pgc$' "$MANIFEST" | sha256sum -c - ) \
      || fail "a restored document hash does not match the manifest"
  fi

  # 2. isolated throwaway cluster
  chown -R postgres "$WORK" 2>/dev/null || true
  $PG_RUNAS initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null \
    || fail "initdb of the throwaway cluster failed"
  $PG_RUNAS pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -k $SOCK" -w start >/dev/null \
    || fail "the throwaway cluster did not start"
  $PG_RUNAS createdb -h "$SOCK" -U postgres restore_verify \
    || fail "could not create the verify database"

  # 3. restore into it
  $PG_RUNAS pg_restore -h "$SOCK" -U postgres -d restore_verify \
    --no-owner --no-privileges --exit-on-error "$DUMP" \
    || fail "pg_restore reported errors"

  # 4. required tables + a sanity row count
  for t in $REQUIRED_TABLES; do
    _present=$($PG_RUNAS psql -h "$SOCK" -U postgres -d restore_verify -tAc \
      "select count(*) from information_schema.tables where table_schema='public' and table_name='$t'")
    [ "$_present" = "1" ] || fail "required table missing after restore: $t"
  done
  ROWS=$($PG_RUNAS psql -h "$SOCK" -U postgres -d restore_verify -tAc \
    'select count(*) from schema_migrations')
  [ "${ROWS:-0}" -ge 1 ] || fail "schema_migrations is empty after restore"

  # 5. open a sample of documents and re-check their hashes
  SAMPLED=0
  if [ -d "$DOCS" ]; then
    grep -v ' dump.pgc$' "$MANIFEST" | shuf | head -n "$SAMPLE_SIZE" > "$WORK/sample.sha256" || true
    SAMPLED=$(wc -l < "$WORK/sample.sha256" | tr -d ' ')
    if [ "$SAMPLED" -gt 0 ]; then
      ( cd "$DOCS" && sha256sum -c - < "$WORK/sample.sha256" ) \
        || fail "a sampled document failed its hash check"
    fi
  fi

  EL=$(( $(date +%s) - START ))
  alert "reino restore-test OK ($SNAP)" \
    "Restored snapshot $SNAP into a throwaway cluster. schema_migrations rows=$ROWS, sampled_documents=$SAMPLED, drill_seconds=$EL. Recovery time scales with data size."
}

main "$@"
