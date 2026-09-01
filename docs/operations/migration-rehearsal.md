# Supabase -> Postgres Migration Rehearsal

> ## NOT YET REHEARSED — blocker for cutover authorization
>
> None of the following have been performed (the migration was built on a host
> with no Docker daemon, no Supabase, no target Postgres):
>
> - [ ] **Migration rehearsal 1** — full sequence from fresh volumes, all numbers below filled
> - [ ] **Migration rehearsal 2** — repeat, numbers must be consistent with run 1
> - [ ] **Rollback rehearsal** — [`rollback.md`](./rollback.md) run end-to-end after a deliberately failed smoke gate, recovery time recorded
> - [ ] **`node scripts/verify-release.mjs` (flagless) green on real infra** — saved as release evidence
>
> `docker-stack.yml` migrate service ships `replicas: 0`; the rehearsal and the
> cutover must `docker service scale <stack>_migrate=1`, confirm exit 0, then
> scale back (Swarm has no run-once ordering). See [`cutover.md`](./cutover.md).

Repeatable, scripted cutover of legacy Supabase data into the secured Postgres
stack. **Read-only against the source.** No step here mutates Supabase or
performs a cutover — Traefik is switched by a human, separately, only after
every gate below is green.

## Tooling

| Step | Command | Notes |
|------|---------|-------|
| 1. Export business rows + identity metadata | `npm run migration:export -- <SOURCE_DATABASE_URL> <OUT_DIR>` | NDJSON per table (FK order) + `manifest.json`. Identity export is metadata only — no password hash, token, session, or MFA secret leaves Supabase. |
| 2. Copy storage objects | `node scripts/migration/copy-storage.mjs <SUPABASE_URL> <SERVICE_KEY> <OUT_DIR>` | Streams one object at a time while hashing. Missing/unreadable object = fatal, recorded in `storage-errors.json`. |
| 3. Create empty target | `DATABASE_OWNER_URL=<target> npm run db:migrate` | Runs `001`..`010` (incl. `010_must_reset_password`). |
| 4. Import | `npm run migration:import -- <TARGET_DATABASE_URL> <OUT_DIR>` | One transaction. Preserves UUIDs + timestamps. Each identity gets a fresh random 32-byte password (hashed, plaintext discarded); profile marked `must_reset_password = true`. Raw bureau payloads replayed through the production adapter v1 (valid -> `bureau_results` + `completed`; invalid -> preserved + `payload_incompatible`). Idempotent — safe to rerun. |
| 5. Verify | `npm run migration:verify -- <TARGET_DATABASE_URL> <OUT_DIR>` | Exact row counts, FKs, unique emails/documents, consultation<->result consistency, storage hashes, audit preservation, absence of any imported credential/session/MFA data. Exits nonzero on any discrepancy. |

Connection strings are passed explicitly (arg or env). Logs print only the
redacted host — never a full DSN or secret.

One-time password-reset links are generated **only** during the authorized
cutover (not by these scripts).

## Rehearsal record

Run the full sequence **twice** from fresh target volumes using a sanitized
full-size export. Every measured value below is a placeholder.

> **PENDING REHEARSAL — fill at the Task 15 cutover-rehearsal gate.**

### Rehearsal 1

| Metric | Value |
|--------|-------|
| Source row total (all active tables) | PENDING REHEARSAL |
| Export elapsed | PENDING REHEARSAL |
| Storage objects / bytes copied | PENDING REHEARSAL |
| Storage copy elapsed | PENDING REHEARSAL |
| Import elapsed | PENDING REHEARSAL |
| Verification elapsed | PENDING REHEARSAL |
| Backup (first full) elapsed | PENDING REHEARSAL |
| Target disk usage after import | PENDING REHEARSAL |
| Export directory disk usage | PENDING REHEARSAL |
| ClamAV peak memory during scan | PENDING REHEARSAL |
| Payloads replayed: valid / incompatible | PENDING REHEARSAL |
| Verification result | PENDING REHEARSAL |

### Rehearsal 2

| Metric | Value |
|--------|-------|
| Source row total (all active tables) | PENDING REHEARSAL |
| Export elapsed | PENDING REHEARSAL |
| Storage objects / bytes copied | PENDING REHEARSAL |
| Storage copy elapsed | PENDING REHEARSAL |
| Import elapsed | PENDING REHEARSAL |
| Verification elapsed | PENDING REHEARSAL |
| Backup (first full) elapsed | PENDING REHEARSAL |
| Target disk usage after import | PENDING REHEARSAL |
| Export directory disk usage | PENDING REHEARSAL |
| ClamAV peak memory during scan | PENDING REHEARSAL |
| Payloads replayed: valid / incompatible | PENDING REHEARSAL |
| Verification result | PENDING REHEARSAL |

### Rollback rehearsal (Task 15 prerequisite P3)

Deliberately fail one Phase 11 smoke gate during a rehearsal, then run every step
of [`rollback.md`](./rollback.md).

| Metric | Value |
|--------|-------|
| Smoke gate failed on purpose | PENDING REHEARSAL |
| New app stopped + target preserved elapsed | PENDING REHEARSAL |
| Old stack restarted against Supabase elapsed | PENDING REHEARSAL |
| Old system re-verified (health/login/query/doc) | PENDING REHEARSAL |
| **Total recovery time (gate fail -> old system serving)** | PENDING REHEARSAL |
| Confirmed: zero writes back into Supabase | PENDING REHEARSAL |
| Confirmed: failed target volumes/logs preserved | PENDING REHEARSAL |

### Downtime estimate

Export + import + verify + backup, measured from the rehearsals, plus smoke
tests and the Traefik switch.

**Estimated cutover downtime: PENDING REHEARSAL**

Repeat the rehearsal until the whole process passes with **no manual database
edits**. If any integrity or smoke gate fails during the real cutover, Traefik
returns to the old application and the Supabase source is left unchanged.
