# Secure Postgres Stack — Security Checklist

Run through this before the first production deploy and again after any infra change.
Every box must be checked with evidence (command output saved outside the repo).

## 1. Secrets — generation & rotation

- [ ] All 22 stack secrets are Docker **external** secrets (never in the compose
  file, never in env files committed to git). The list is the `secrets` section of
  `docker-stack.yml`.
- [ ] `scripts/setup/setup_production.py` generates the secrets and creates them in Docker.
- [ ] Generate each high-entropy secret with:
  ```sh
  openssl rand -base64 48        # BETTER_AUTH_SECRET, restic_password, DB passwords
  printf %s "$VALUE" | docker secret create <name> -
  ```
- [ ] `database_url` uses role `app_runtime` (NOSUPERUSER NOBYPASSRLS).
  `database_owner_url` uses the `postgres` superuser. Only the one-shot `migrate`
  service reads it: migrations run `CREATE ROLE` / `ALTER ROLE ... [NO]BYPASSRLS`,
  which require superuser. `reino_app` never gets this DSN (see §6).
- [ ] `.env.local`, `.env*.example` contain **no real secret values** and are gitignored / not staged.
- [ ] `credenciais-GUARDAR.txt` was moved to a password manager and deleted from the server.
- [ ] Rotation procedure documented: `docker secret rm` + recreate + `docker
  service update --force <svc>` per consuming service. Rotate
  `better_auth_secret` only during a maintenance window (invalidates sessions).
- [ ] DEPS + OpenAI + SMTP credentials are least-privilege API keys, revocable
  independently.

## 2. Network / firewall

- [ ] Host firewall: inbound only 22 (restricted source), 80, 443. Docker Swarm
  ports (2377/7946/4789) not exposed to the internet.
- [ ] `private` overlay network is `internal: true` and `encrypted: true` — no
  egress, encrypted node-to-node.
- [ ] `postgres`, `clamav`, `backup` are on `private` **only** — not
  reachable from `RainhaNet` / the internet.
- [ ] `backup` has no Docker socket, no published port, no `RainhaNet`.

## 3. Traefik / TLS

- [ ] `reino_app` served only on the `websecure` entrypoint with
  `tls.certresolver=letsencryptresolver`; no plaintext `web` router.
- [ ] HTTP→HTTPS redirect enforced at the Traefik entrypoint level.
- [ ] `TRAEFIK_PROXY_CIDR` is the real proxy subnet (validated by config) so
  forwarded-IP / rate-limit trust is correct.
- [ ] HSTS header set (Traefik middleware or app).

## 4. Backup repository (off-site, S3-compatible Restic)

- [ ] Bucket dedicated to the Restic repository, with public access fully blocked
  (no ACL). (post-deploy)
- [ ] History is protected against the server key. A key that can delete objects
  can also delete object versions, and R2 has no classic versioning. Use Object
  Lock (governance or compliance, retention of 30 days or more) OR a key/bucket
  policy that denies `s3:DeleteObjectVersion`, `s3:PutLifecycleConfiguration` and
  `s3:PutBucketVersioning`. Then `restic forget --prune` needs lock-aware
  retention (`--keep-*` not shorter than the lock period) or a separate
  credential. (post-deploy)
- [ ] Access key scoped to that bucket only. It is stored as the Docker secrets
  `restic_s3_access_key` and `restic_s3_secret_key`; the scripts export them as
  `AWS_*`. Never in the env file or in argv.
- [ ] `RESTIC_REPOSITORY` starts with `s3:`. The backup and restore scripts refuse
  any other repository. `BACKUP_ALLOW_LOCAL_REPO` exists only for the test
  harness and is not set in production.
- [ ] `restic_password` stored only as a Docker secret; losing it = unrecoverable
  backups — escrow it offline.
- [ ] **Residual risk accepted (D14):** the backup container can write and delete
  objects in the bucket. Object Lock or the deny policy above is the defense
  against deletion. A compromise of the storage provider account is not covered.

## 5. Restore evidence

- [ ] `sh docker/backup/backup.test.sh` passes. `npm run ops:test` runs it when
  `restic` is on the PATH and skips it otherwise.
- [ ] `restore-test.sh` restores into an isolated throwaway cluster and every table
  in `RESTORE_REQUIRED_TABLES` is in the restored dump. (post-deploy)
- [ ] Measured restore duration (RTO) is recorded. The recovery runbook does not
  exist yet. (post-deploy)
- [ ] Monthly drill (`0 4 1 * *` cron) emails `BACKUP_ALERT_TO`. The first drill is
  run by hand (see [deploy.md](deploy.md), step 4.6). Alert path tested (SMTP creds
  via `--netrc-file`, never on argv).
- [ ] Alert `backup_stale` fires when the success marker is older than 36 h (see
  [monitoring.md](monitoring.md)).

## 6. Database roles & RLS

Run after schema migrate (`\du` and the queries below as `postgres`):

- [ ] `app_runtime`: `NOSUPERUSER`, **`NOBYPASSRLS`**, no CREATE on schema public.
- [ ] `backup_reader`: the **only** role with `BYPASSRLS` (read-only, needed for
  consistent `pg_dump`).
- [ ] `auth_profile_lookup` (migration 009): `NOLOGIN`, `NOINHERIT`,
  **`NOBYPASSRLS`**, narrow column grants + role-specific FORCE-RLS policies only.
- [ ] Volume do Postgres montado em `/var/lib/postgresql` (layout do PG18). Stack antiga, com mount em `/var/lib/postgresql/data`, guarda os dados em volume anônimo. Rode `pg_dump` antes de redeployar.
- [ ] `schema_owner`: owns objects, not used at runtime.
  ```sql
  select rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
    from pg_roles where rolname in
    ('app_runtime','backup_reader','auth_profile_lookup','schema_owner','postgres');
  select relname, relrowsecurity, relforcerowsecurity
    from pg_class where relkind='r' and relnamespace='public'::regnamespace
    order by relname;
  ```
- [ ] Every tenant-scoped table has `relrowsecurity = true`; RLS-critical tables
  also `relforcerowsecurity = true`.
- [ ] Integration suites `rls.integration`, `domain.integration`,
  `service.integration`, `auth.integration`, `*.queries.integration` pass against
  the real target (verify-release gate 12).
- [ ] Public SCR authorization link (migration 008) is single-use / non-replayable.
- [ ] `reino_app` has no owner DSN. These commands show no `database_owner_url`,
  no `DATABASE_OWNER_URL_FILE` and no `RUN_MIGRATIONS` in `reino_app`:
  ```sh
  docker service inspect reino_reino_app --format '{{json .Spec.TaskTemplate.ContainerSpec.Secrets}}'
  docker service inspect reino_reino_app --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'
  ```
  Only `reino_migrate` lists `database_owner_url`.

## 7. File permissions (`DOCUMENT_ROOT`)

- [ ] `documents` volume mounted at `/var/lib/reino/documents`; container runs as
  `1001:1001`; root filesystem `read_only: true`, only `/tmp` (noexec,nosuid,
  nodev) and the documents volume writable.
- [ ] `backup` mounts the documents volume **`:ro`**.
- [ ] Stored objects are content-addressed (relative UUID keys); no user-supplied
  path segments reach the filesystem.
- [ ] Upload path: magic-byte sniff + size cap streamed + ClamAV `INSTREAM` scan
  before the object is persisted; scan failure = fail-closed (reject).

## 8. Log redaction

- [ ] Migration scripts print only the **redacted DSN host** — never a full
  connection string, password, token, or MFA secret.
- [ ] `001-users.sh` init script reads passwords via `\getenv`, never psql argv.
- [ ] Backup alert emails send SMTP creds via a `0600` tmpfs `--netrc-file`,
  removed in the same subshell — never `--user user:pass`.
- [ ] App logs do not contain request bodies with CPF/CNPJ beyond what the domain
  requires; DEPS provider error bodies are not logged verbatim.
- [ ] `json-file` logging capped (`max-size: 10m`, `max-file: 3`).

## 9. TOTP enforcement (staff)

- [ ] Every `staff` / `admin` profile must complete TOTP enrollment; protected
  routes reject a session without a verified second factor.
- [ ] `revokeSessionsOnPasswordReset: true` is set in the Better Auth config.

## 10. Image / patch ownership

- [ ] `reino_app` and `backup` deploy by **digest only**
  (`ghcr.io/<owner>/reino-credito@sha256:<digest>`,
  `ghcr.io/<owner>/reino-backup@sha256:<digest>`); a mutable tag or `latest`
  cannot satisfy `docker-stack.yml`.
- [ ] `reino-backup` image is built + pushed by CI (add the `build-backup` job to
  `.github/workflows/docker-image.yml`)
  and deployed by `REINO_BACKUP_DIGEST`.
- [ ] Base images pinned (`postgres:18.6-alpine3.23`, `clamav/clamav:1.4.6_...`,
  `restic/restic:0.18.1`, `node:...` in the app Dockerfile).
- [ ] A named owner is responsible for monthly base-image + dependency updates
  and re-running `npm run verify:release` after each.
- [ ] `npm audit` reviewed; no known-exploitable high/critical in production deps.

## 11. Cupons

- [x] Done: the coupon code attempts have a limit of 10 misses per hour per client profile (migration 052, table `coupon_attempt_misses`, no grant to `app_runtime`). `coupon_preview` records a miss for each code that gives no coupon. Over the limit it returns no rows, also for a valid code. `reserve_order` only checks the limit (a refused order rolls back, so a miss written there would be lost). Misses are also counted from the order action: when `placeOrder` aborts for a code problem (`coupon_invalid`, `coupon_expired`, `coupon_exhausted`, `coupon_client_limit`, `coupon_product_not_allowed`), it records one miss in a separate committed transaction (migration 053, `coupon_record_miss()`); `coupon_funds_insufficient` does not count. The answer stays "Cupom inválido ou indisponível" (unknown, expired, exhausted, other Bureau or out of scope).
