# Supabase → Secure Postgres — Cutover Runbook

> **NOT YET REHEARSED — blocker for cutover authorization.**
> The two full-size migration rehearsals, the one rollback rehearsal, and one
> green **flagless** `node scripts/verify-release.mjs` run on the real target
> infrastructure have **not** been performed (this repo was built on a host with
> no Docker daemon, no Supabase, no target Postgres). Do not schedule a cutover
> window until all four are done and recorded — see
> [`migration-rehearsal.md`](./migration-rehearsal.md) and the *Operator
> prerequisites* section below.

This runbook performs a **reversible** cutover. Every command is literal and
copy-pasteable. It never mutates the Supabase source. If any go/no-go gate or
smoke check fails, follow [`rollback.md`](./rollback.md) — the Supabase project
and its original storage stay read-only and untouched until a **separately
authorized** retirement window.

Placeholders (`<...>`) and the `$VAR` values in *Environment* are set once by the
operator at the top of the shell session.

---

## Operator prerequisites (do these before the cutover window)

These are the items deferred through Tasks 1–14 because this host could not run
them. Every one must be green before authorization.

| # | Prerequisite | How |
|---|---|---|
| P1 | **`verify:release` green, flagless, on real infra** | `node scripts/verify-release.mjs` (no `--allow-deferred`) from a clean tree, against a disposable target Postgres + a running Docker daemon + full production env. Save the terminal output outside the repo as release evidence. |
| P2 | **2× full-size migration rehearsal** | Run *Phase 3–7* below twice from fresh volumes with a sanitized full-size export; record every number in [`migration-rehearsal.md`](./migration-rehearsal.md) (replaces its PENDING markers). |
| P3 | **1× rollback rehearsal** | After deliberately failing a smoke gate in a rehearsal, run [`rollback.md`](./rollback.md) end-to-end and record recovery time in [`migration-rehearsal.md`](./migration-rehearsal.md). |
| P4 | **`reino-backup` image built & pushed** | `docker-publish.yml` was deleted. Add a second job to `.github/workflows/docker-image.yml` (YAML below) so `ghcr.io/<owner>/reino-backup@sha256:<digest>` exists; take `REINO_BACKUP_DIGEST` from its job summary. |
| P5 | **`reino-credito` image built & pushed** | Push to `main` (or run the workflow); take `REINO_IMAGE_OWNER` + `REINO_IMAGE_DIGEST` from the *Report deployable digest* job summary. Deploy is digest-only — a tag can never satisfy `docker-stack.yml`. |
| P6 | **All 13 external secrets created** in the target Swarm | `database_url`, `database_owner_url`, `better_auth_secret`, `smtp_pass`, `deps_api_password`, `openai_api_key`, `postgres_password`, `schema_owner_password`, `app_runtime_password`, `backup_reader_password`, `restic_password`, `backup_s3_access_key`, `backup_s3_secret_key` — see [`security-checklist.md`](./security-checklist.md). |
| P7 | **S3 bucket for Restic** has object versioning ON and all public access DENIED. |
| P8 | **DB roles verified** after schema migrate: `app_runtime` NOBYPASSRLS, only `backup_reader` BYPASSRLS, `auth_profile_lookup` NOLOGIN/NOINHERIT/NOBYPASSRLS (migration 009). See [`security-checklist.md`](./security-checklist.md). |
| P9 | **Restore drill passes** — `sh docker/backup/backup.test.sh` and a real `restore-test.sh` run into a throwaway cluster, evidence saved. |

### P4 — CI job to add for the backup image

```yaml
  build-backup:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: build
        uses: docker/build-push-action@v6
        with:
          context: ./docker/backup
          push: true
          tags: ghcr.io/${{ github.repository_owner }}/reino-backup:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Report backup digest
        run: |
          echo "### Backup image" >> "$GITHUB_STEP_SUMMARY"
          echo '```' >> "$GITHUB_STEP_SUMMARY"
          echo "REINO_BACKUP_DIGEST=${{ steps.build.outputs.digest }}" | sed 's/sha256://' >> "$GITHUB_STEP_SUMMARY"
          echo '```' >> "$GITHUB_STEP_SUMMARY"
```

---

## Environment (set once, at the top of the cutover shell)

```sh
export STACK=reino
export REINO_IMAGE_OWNER=<github-owner>
export REINO_IMAGE_DIGEST=<64-hex sha256 of reino-credito release image>
export REINO_BACKUP_DIGEST=<64-hex sha256 of reino-backup image>
export APP_DOMAIN=<app.example.com>
export TRAEFIK_PROXY_CIDR=<10.0.0.0/24>
export RESTIC_REPOSITORY='s3:https://s3.<region>.amazonaws.com/<bucket>'
export BACKUP_ALERT_TO=<ops@example.com>
export SMTP_HOST=<smtp.example.com> SMTP_PORT=465 SMTP_SECURE=true
export SMTP_USER=<user> SMTP_FROM=<no-reply@example.com>
export DEPS_API_EMAIL=<deps-user>

# One-shot migration credentials (NOT committed, NOT in shell history files):
export SOURCE_DATABASE_URL='postgresql://<ro-user>:<pw>@<supabase-host>:5432/postgres?sslmode=require'
export SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_KEY='<service-role-key>'   # storage read only
export TARGET_DATABASE_OWNER_URL='postgresql://schema_owner:<pw>@<target-host>:5432/credit_system'
export OUT=/var/lib/reino/cutover/$(date +%Y%m%dT%H%M%S)
mkdir -p "$OUT"
```

---

## Phase 1 — Announce maintenance

```sh
# 1. Post the maintenance notice (status page / email to staff + clients).
# 2. Record the start time.
echo "cutover start: $(date -Is)" | tee -a "$OUT/timeline.txt"
```

## Phase 2 — Reject new writes on the old system

```sh
# Put the OLD (Supabase-backed) app into read-only / maintenance mode so no new
# row is written after the export snapshot. Keep it serving reads.
# (Old app = current production deployment. Use its own maintenance toggle.)
```

## Phase 3 — Final Supabase export (read-only)

```sh
npm run migration:export -- "$SOURCE_DATABASE_URL" "$OUT"
node scripts/migration/copy-storage.mjs "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$OUT"
```

- NDJSON per table in FK order + `manifest.json`. Identity export is **metadata
  only** — no password hash, token, session, or MFA secret leaves Supabase.
- Storage copy streams one object at a time while hashing; a missing/unreadable
  object is FATAL and recorded in `$OUT/storage-errors.json` — **stop and
  investigate** if that file is non-empty.

## Phase 4 — Hash manifest

```sh
( cd "$OUT" && find . -type f ! -name manifest.sha256 -print0 \
    | sort -z | xargs -0 sha256sum > manifest.sha256 )
sha256sum "$OUT/manifest.sha256" | tee -a "$OUT/timeline.txt"
# Copy manifest.sha256 off-box now; re-verify before Phase 7 import.
```

## Phase 5 — Stop the old app

```sh
# Fully stop the old deployment (no writes, no reads). Point Traefik at a
# static maintenance page. Do NOT delete the Supabase project or its storage.
```

## Phase 6 — Fresh target volumes + schema migrate

```sh
docker stack rm "$STACK" 2>/dev/null; sleep 15
docker volume rm ${STACK}_postgres_data ${STACK}_documents ${STACK}_clamav_data \
                 ${STACK}_backup_state ${STACK}_backup_work 2>/dev/null || true

docker stack deploy -c docker-stack.yml "$STACK"     # postgres + clamav come up; migrate has replicas:0

# Wait for postgres healthy:
until docker exec "$(docker ps -q -f name=${STACK}_postgres)" pg_isready -U postgres -d credit_system; do sleep 3; done

# One-shot schema migration (Swarm has no run-once ordering — do it explicitly):
docker service scale ${STACK}_migrate=1
docker service logs -f ${STACK}_migrate &      # watch it
docker service ps --no-trunc ${STACK}_migrate  # confirm the task exited 0
docker service scale ${STACK}_migrate=0
```

Runs `001`..`010` including `010_must_reset_password`. Second run (rollback
rehearsal / re-run) must be a clean no-op.

## Phase 7 — Import

```sh
sha256sum -c "$OUT/manifest.sha256"    # must pass before importing
npm run migration:import -- "$TARGET_DATABASE_OWNER_URL" "$OUT"
```

One transaction. Preserves source UUIDs + timestamps. Every identity gets a
**fresh random 32-byte password** (hashed, plaintext discarded); profile marked
`must_reset_password = true`. No legacy credential/session/MFA data is imported.
Raw bureau payloads replay through the production adapter v1 (valid →
`bureau_results` + `completed`; invalid → preserved + `payload_incompatible`).
Idempotent — safe to rerun.

## Phase 8 — Verify (go/no-go gate 1)

```sh
npm run migration:verify -- "$TARGET_DATABASE_OWNER_URL" "$OUT"
```

Exact row counts, **all** foreign keys, unique emails/documents,
consultation↔result consistency, storage SHA-256, audit append-only
preservation, and the **absence** of any imported credential/session/MFA data.
Any nonzero exit = **NO-GO** → [`rollback.md`](./rollback.md).

> Known ceiling (Task 14): business-table inserts derive columns from NDJSON
> keys; `FOREIGN_KEYS` in `verify.mjs` omits 4 nullable convenience FKs
> (`crm_clients.assigned_to`/`user_id`, `ai_reports.reviewed_by`,
> `company_reports.reviewed_by` → `profiles`). Spot-check these manually during
> the rehearsal and add them to the map if the rehearsal surfaces drift.

## Phase 9 — Encrypted backup before opening traffic

```sh
docker service ps ${STACK}_backup                       # already replicas:1 (crond)
docker exec "$(docker ps -q -f name=${STACK}_backup)" /opt/backup/backup.sh
# Confirm: success marker written, snapshot listed:
docker exec "$(docker ps -q -f name=${STACK}_backup)" restic snapshots --latest 1
```

## Phase 10 — Start the new app (digest-pinned)

```sh
docker service scale ${STACK}_reino_app=1
until wget -qO- "http://$(docker ps -q -f name=${STACK}_reino_app | head -1 && echo):3000/api/health/live"; do sleep 3; done
```

(`reino_app` is `replicas: 1` in the stack; the scale call is a no-op if it is
already up — included so the ordering is explicit.)

## Phase 11 — Smoke checks (go/no-go gates 2–8)

Run [the go/no-go table below](#gono-go-gate-table). All must be GO.

```sh
# Health / readiness
curl -fsS https://$APP_DOMAIN/api/health/live      # -> ok
curl -fsS https://$APP_DOMAIN/api/health/ready     # -> ready (DB + doc volume writable)
```

Then, in a browser: staff TOTP login; client login → forced password reset;
a PF DEPS consultation (current + legacy fixture); a document upload → ClamAV
scan → download; confirm a non-owning user gets 404 on someone else's document
(RLS). Public SCR authorization link opens and cannot be replayed.

## Phase 12 — Issue one-time reset links

> **Cutover-authorization boundary.** Only after gates 1–8 are GO.

```sh
# Generate one-time password-reset links for every preserved identity and send
# them via the app's own reset flow. These are NOT produced by the migration
# scripts. Batch-send; track delivery.
```

## Phase 13 — Switch Traefik / DNS to the new app

> Requires explicit cutover authorization from the user.

```sh
# Remove the maintenance router; the reino_app Traefik labels in docker-stack.yml
# take over Host(`$APP_DOMAIN`) on the websecure entrypoint with letsencrypt.
docker service update --force ${STACK}_reino_app
```

## Phase 14 — Monitor

- Watch `docker service logs -f ${STACK}_reino_app` and the DB for 60 min.
- Confirm the next scheduled `backup.sh` (02:30) and that ClamAV freshclam is current.
- Error-rate, auth success, consultation success within normal bounds.

## Phase 15 — Declare completion

```sh
echo "cutover complete: $(date -Is)" | tee -a "$OUT/timeline.txt"
# Announce completion. Supabase + original storage remain READ-ONLY and
# UNTOUCHED until a separately authorized retirement window (see rollback.md).
```

---

## Go/no-go gate table

Evaluate at Phase 8 (gate 1) and Phase 11 (gates 2–8). **Any NO-GO → stop, run
[`rollback.md`](./rollback.md).**

| # | Gate | GO condition | Command / check |
|---|---|---|---|
| 1 | Migration verification | Zero errors | `npm run migration:verify -- "$TARGET_DATABASE_OWNER_URL" "$OUT"` exits 0 |
| 2 | Clean restore test | Dump restores into a throwaway cluster; all `RESTORE_REQUIRED_TABLES` present | `sh docker/backup/backup.test.sh` + `docker exec … /opt/backup/restore-test.sh` |
| 3 | Staff TOTP flow | Enroll + login with TOTP succeeds; staff cannot skip MFA | browser |
| 4 | Client login / reset | One-time reset link sets a password; subsequent login works | browser |
| 5 | DEPS consultation | Current **and** legacy payload fixtures both render a canonical result | browser + `npx vitest run src/lib/deps` |
| 6 | Documents | Upload → ClamAV clean scan → download works; EICAR is rejected | browser |
| 7 | RLS isolation | Non-owner gets 404 on another tenant's doc/consultation; public SCR link non-replayable | browser + `npx vitest run **/*.integration.test.ts` on real PG |
| 8 | Health / readiness | `/api/health/live` = `ok`, `/api/health/ready` = `ready` | `curl` (Phase 11) |

Integration suites behind gates 1/7 (`rls.integration`, `domain.integration`,
`service.integration`, `auth.integration`, `queries.integration`,
`portal…queries.integration`) require a reachable Postgres and are part of P1.
