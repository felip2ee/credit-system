#!/bin/sh
# Daily encrypted backup.
#
# One Restic snapshot == custom-format PostgreSQL dump + SHA-256 manifest +
# provenance meta + the private document tree. A failed dump writes NO success
# marker and starts NO snapshot. Retention (prune.sh) runs only after a good
# snapshot.
set -eu

BACKUP_HOME="${BACKUP_HOME:-/opt/backup}"
STATE_DIR="${STATE_DIR:-/var/lib/backup}"
WORK_ROOT="${WORK_ROOT:-/work}"
LOCK_DIR="${LOCK_DIR:-/run/lock/reino-backup.lock}"
DOCUMENT_ROOT="${DOCUMENT_ROOT:-/var/lib/reino/documents}"

# --- shared helpers -------------------------------------------------------
read_file_env() {
  # read_file_env VAR : if $VAR is empty and ${VAR}_FILE is a readable file,
  # export VAR with its contents. Keeps secrets out of the stack env / argv.
  eval "_v=\${$1:-}"; eval "_f=\${${1}_FILE:-}"
  if [ -z "$_v" ] && [ -n "$_f" ] && [ -r "$_f" ]; then
    _v=$(cat "$_f"); export "$1=$_v"
  fi
}

load_secrets() {
  read_file_env RESTIC_PASSWORD
  read_file_env AWS_ACCESS_KEY_ID
  read_file_env AWS_SECRET_ACCESS_KEY
  read_file_env PGPASSWORD
  read_file_env SMTP_PASS
}

alert() {
  # alert SUBJECT BODY : always logs; also emails when SMTP is configured.
  # Body must never contain secrets or PII -- callers pass snapshot ids/counts.
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
# -----------------------------------------------------------------------

main() {
  load_secrets
  mkdir -p "$STATE_DIR" "$WORK_ROOT"

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "another backup run holds $LOCK_DIR; exiting" >&2
    exit 1
  fi
  STAGE="$WORK_ROOT/staging"
  trap 'rm -rf "$LOCK_DIR" "${STAGE:-}"' EXIT INT TERM

  rm -rf "$STAGE"; mkdir -p "$STAGE"
  DUMP="$STAGE/dump.pgc"
  MANIFEST="$STAGE/manifest.sha256"
  META="$STAGE/meta.json"

  # 1. custom-format dump -- no owner, no privileges. Failure => stop here.
  if ! pg_dump --format=custom --no-owner --no-privileges --file="$DUMP"; then
    alert "reino backup FAILED: pg_dump error" \
      "pg_dump did not complete. No snapshot was created and no retention ran."
    exit 1
  fi

  # 2. SHA-256 manifest: the dump (relative) + every document (relative to root)
  ( cd "$STAGE" && sha256sum dump.pgc ) > "$MANIFEST"
  if [ -d "$DOCUMENT_ROOT" ]; then
    ( cd "$DOCUMENT_ROOT" && find . -type f | sort | sed 's|^\./||' \
        | while IFS= read -r f; do sha256sum "$f"; done ) >> "$MANIFEST"
  fi

  # 3. provenance metadata (no secrets)
  _pgver=$(psql -tAc 'show server_version' 2>/dev/null || echo unknown)
  _mig=$(psql -tAc "select coalesce(max(version)::text,'none') from schema_migrations" 2>/dev/null || echo unknown)
  _files=0
  [ -d "$DOCUMENT_ROOT" ] && _files=$(find "$DOCUMENT_ROOT" -type f | wc -l | tr -d ' ')
  cat > "$META" <<EOF
{
  "created_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "postgres_server_version": "$_pgver",
  "schema_migration_version": "$_mig",
  "document_file_count": $_files,
  "app_image_digest": "${REINO_IMAGE_DIGEST:-unset}"
}
EOF

  # 4. ONE snapshot: dump + manifest + meta + documents
  set -- "$DUMP" "$MANIFEST" "$META"
  [ -d "$DOCUMENT_ROOT" ] && set -- "$@" "$DOCUMENT_ROOT"
  if ! restic backup --host reino --tag reino-daily "$@"; then
    alert "reino backup FAILED: restic error" \
      "The dump succeeded but the Restic snapshot failed. Retention was NOT run."
    exit 1
  fi

  _snap=$(restic snapshots --latest 1 --json | jq -r '.[-1].short_id // "unknown"')
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_snap" > "$STATE_DIR/last-success"

  # 5. retention -- only reached after a successful snapshot
  if ! "$BACKUP_HOME/prune.sh"; then
    alert "reino backup WARNING: prune failed" \
      "Snapshot $_snap is safe. restic forget/prune returned non-zero; check retention."
  fi

  alert "reino backup OK ($_snap)" \
    "Snapshot $_snap created. documents=$_files schema_migration=$_mig."
}

main "$@"
