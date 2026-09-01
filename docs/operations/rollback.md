# Cutover Rollback Runbook

> **NOT YET REHEARSED — blocker for cutover authorization.**
> This procedure must be rehearsed once (Task 15 / prerequisite P3): after a
> deliberately failed smoke gate in a migration rehearsal, run every step below
> and record the recovery time in [`migration-rehearsal.md`](./migration-rehearsal.md).

Use this the moment any go/no-go gate in [`cutover.md`](./cutover.md) is NO-GO,
or any Phase 11 smoke check fails, **before** reset links are issued (Phase 12).
The old Supabase-backed system is still intact and is the rollback target.

## Absolute rules

- **NEVER reverse-copy** partial writes from the new target into Supabase. Not
  one row. The target is abandoned, not merged back.
- The Supabase project and its original storage bucket stay **read-only and
  untouched** until a **separately authorized** retirement window — days later,
  minimum, and only after the new system is proven stable.
- Do **not** delete the failed target volumes or logs — they are the post-mortem
  evidence.

## Environment

```sh
export STACK=reino
```

## Step 1 — Stop the new app

```sh
docker service scale ${STACK}_reino_app=0
docker service scale ${STACK}_migrate=0     # ensure the one-shot is not running
docker service scale ${STACK}_backup=0      # pause scheduled backups of the dead target
```

## Step 2 — Preserve the failed target (do NOT delete)

```sh
TS=$(date +%Y%m%dT%H%M%S)
mkdir -p /var/lib/reino/rollback-$TS
docker service logs --no-trunc ${STACK}_reino_app  > /var/lib/reino/rollback-$TS/app.log   2>&1
docker service logs --no-trunc ${STACK}_migrate    > /var/lib/reino/rollback-$TS/migrate.log 2>&1
docker service logs --no-trunc ${STACK}_postgres   > /var/lib/reino/rollback-$TS/pg.log     2>&1

# Snapshot the target DB + document volume for the post-mortem, then leave them.
docker run --rm -v ${STACK}_postgres_data:/v -v /var/lib/reino/rollback-$TS:/out \
  alpine tar czf /out/postgres_data.tgz -C /v .
docker run --rm -v ${STACK}_documents:/v -v /var/lib/reino/rollback-$TS:/out \
  alpine tar czf /out/documents.tgz -C /v .

# Do NOT run `docker volume rm` on any ${STACK}_* volume here.
```

## Step 3 — Restart the untouched old stack against the unchanged Supabase source

```sh
# Bring the OLD (pre-migration) production deployment back up, pointed at the
# SAME Supabase database + storage it always used. No connection string changes.
# Lift its maintenance / read-only toggle so it accepts writes again.
```

## Step 4 — Point Traefik / DNS back at the old app

```sh
# Restore the old router (or remove the maintenance page) so Host(<APP_DOMAIN>)
# resolves to the old application again.
```

## Step 5 — Verify the old system

```sh
curl -fsS https://<APP_DOMAIN>/               # old app serves
# In a browser, on the OLD app:
#  - staff login works (old credentials — no reset was issued)
#  - a client login works
#  - open one existing consultation / one client record (a real read query)
#  - upload + download one document (Supabase storage path)
```

All four must pass before you communicate "service restored".

## Step 6 — Communicate

- Post "service restored on the previous system; migration postponed".
- Notify staff their credentials are unchanged and **no reset link is valid**
  (none were issued — if Phase 12 had started, this is a different, larger
  incident: invalidate every issued token immediately).
- Open a post-mortem using the `/var/lib/reino/rollback-$TS/` evidence and the
  `verify.mjs` discrepancy output.

## Step 7 — Later: clean up the abandoned target (only when the postmortem is done)

```sh
docker stack rm ${STACK}
docker volume rm ${STACK}_postgres_data ${STACK}_documents ${STACK}_clamav_data \
                 ${STACK}_backup_state ${STACK}_backup_work
```

Supabase retirement is **not** part of rollback and needs its own authorization.
