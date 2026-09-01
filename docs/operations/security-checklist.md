# Secure Postgres Stack — Security Checklist

Run through this before cutover authorization and again after any infra change.
Every box must be checked with evidence (command output saved outside the repo).

## 1. Secrets — generation & rotation

- [ ] All 11 stack secrets are Docker **external** secrets (never in the compose
  file, never in env files committed to git):
  `database_url`, `database_owner_url`, `better_auth_secret`, `smtp_pass`,
  `deps_api_password`, `openai_api_key`, `postgres_password`,
  `schema_owner_password`, `app_runtime_password`, `backup_reader_password`,
  `restic_password`.
- [ ] Generate each high-entropy secret with:
  ```sh
  openssl rand -base64 48        # BETTER_AUTH_SECRET, restic_password, DB passwords
  printf %s "$VALUE" | docker secret create <name> -
  ```
- [ ] `database_url` uses role `app_runtime` (NOSUPERUSER NOBYPASSRLS).
  `database_owner_url` — consumed by the `reino_app` entrypoint (auto-migrate)
  and the manual import/verify steps — uses the `postgres` superuser: migrations run
  `CREATE ROLE` / `ALTER ROLE ... [NO]BYPASSRLS` and the import bypasses FORCE
  RLS, both of which require superuser. The app service never gets this DSN.
- [ ] `.env.local`, `.env*.example`, and `".env.local - Copia.example"` contain
  **no real secret values** and are gitignored / not staged.
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

## 4. Backup repository (on-server, local encrypted Restic)

- [ ] `restic_repo` volume is bound to a **separate disk** (provider block storage
  at `/srv/reino-restic`), not the primary disk — a primary-disk failure must not
  take the backups with it.
- [ ] The disk / mount is not world-readable; the volume is only mounted into the
  `backup` service (`read_only` container, no shell exposure).
- [ ] `restic_password` stored only as a Docker secret; losing it = unrecoverable
  backups — escrow it offline.
- [ ] **Residual risk accepted**: backups live on the same VPS. They survive DB
  corruption, a bad migration, an accidental delete, and app-level compromise,
  but NOT total loss of the host / provider account. If off-site copies become a
  requirement, add a periodic `restic copy` to a remote repo (the only external
  dependency the design would then take).

## 5. Restore evidence

- [ ] `sh docker/backup/backup.test.sh` passes (failed dump/snapshot cannot write
  a success marker or trigger prune).
- [ ] `restore-test.sh` has run into an isolated throwaway cluster; all
  `RESTORE_REQUIRED_TABLES` (20 core tables) found in the restored dump.
- [ ] Measured restore (RTO) recorded in
  [`migration-rehearsal.md`](./migration-rehearsal.md) and the recovery runbook.
- [ ] Monthly restore drill (`0 4 1 * *` cron) emails `BACKUP_ALERT_TO`; alert
  path tested (SMTP creds via `--netrc-file`, never on argv).

## 6. Database roles & RLS

Run after schema migrate (`\du` and the queries below as `postgres`):

- [ ] `app_runtime`: `NOSUPERUSER`, **`NOBYPASSRLS`**, no CREATE on schema public.
- [ ] `backup_reader`: the **only** role with `BYPASSRLS` (read-only, needed for
  consistent `pg_dump`).
- [ ] `auth_profile_lookup` (migration 009): `NOLOGIN`, `NOINHERIT`,
  **`NOBYPASSRLS`**, narrow column grants + role-specific FORCE-RLS policies only.
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
  connection string, password, token, or MFA secret (`redactDsn` in
  `scripts/migration/lib.mjs`).
- [ ] `001-users.sh` init script reads passwords via `\getenv`, never psql argv.
- [ ] Backup alert emails send SMTP creds via a `0600` tmpfs `--netrc-file`,
  removed in the same subshell — never `--user user:pass`.
- [ ] App logs do not contain request bodies with CPF/CNPJ beyond what the domain
  requires; DEPS provider error bodies are not logged verbatim.
- [ ] `json-file` logging capped (`max-size: 10m`, `max-file: 3`).

## 9. TOTP enforcement (staff)

- [ ] Every `staff` / `admin` profile must complete TOTP enrollment; protected
  routes reject a session without a verified second factor.
- [ ] Clients are not forced into TOTP but the reset flow issues fresh passwords
  (`must_reset_password`, migration 010) on first post-migration login.
- [ ] `revokeSessionsOnPasswordReset: true` is set in the Better Auth config.

## 10. Image / patch ownership

- [ ] `reino_app` and `backup` deploy by **digest only**
  (`ghcr.io/<owner>/reino-credito@sha256:<digest>`,
  `ghcr.io/<owner>/reino-backup@sha256:<digest>`); a mutable tag or `latest`
  cannot satisfy `docker-stack.yml`.
- [ ] `reino-backup` image is built + pushed by CI (add the `build-backup` job to
  `.github/workflows/docker-image.yml` — YAML in [`cutover.md` §P4](./cutover.md#p4--ci-job-to-add-for-the-backup-image))
  and deployed by `REINO_BACKUP_DIGEST`.
- [ ] Base images pinned (`postgres:18.6-alpine3.23`, `clamav/clamav:1.4.6_...`,
  `restic/restic:0.18.1`, `node:...` in the app Dockerfile).
- [ ] A named owner is responsible for monthly base-image + dependency updates
  and re-running `npm run verify:release` after each.
- [ ] `npm audit` reviewed; no known-exploitable high/critical in production deps.
