# Secure PostgreSQL Docker Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase with a secure single-server Docker deployment using private PostgreSQL, Better Auth, validated/versioned DEPS payloads, private document storage, and encrypted off-site backups while preserving all active business data and identifiers.

**Architecture:** Keep the Next.js application as a modular monolith behind Traefik. Route database work through explicit `pg` transactions that set PostgreSQL RLS identity locally. Save every DEPS response as immutable raw JSONB, adapt it once into a validated canonical JSONB contract, and make UI/PDF/AI consumers read only that contract. Store documents outside the web root, scan with ClamAV, and back up PostgreSQL plus files with encrypted Restic snapshots to S3.

**Tech Stack:** Next.js 14, Node.js 22, TypeScript, `pg` 8.21, PostgreSQL 18.6, Better Auth 1.7.2 with TOTP, Docker Swarm/Compose, Traefik, ClamAV 1.4.6, Restic 0.18.1, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-postgres-docker-security-design.md`

## Global Constraints

- Preserve active UUIDs, timestamps, users, consultations, reports, raw provider payloads, CRM records, audit records, settings, and document bytes.
- Do not import Supabase password hashes, sessions, reset tokens, MFA secrets, or recovery codes. Every user establishes a new password; staff must enroll TOTP before protected staff pages.
- Do not expose PostgreSQL, ClamAV, or document volumes publicly. Only Traefik may reach the application.
- Keep `app_runtime` without `BYPASSRLS`; only the isolated backup role may bypass RLS for dumps.
- Use plain SQL and small domain functions. No ORM, generic repository layer, Redis, MinIO, queue, microservice, or Supabase compatibility facade.
- Never log authorization headers, passwords, TOTP secrets, document contents, full CPF/CNPJ values, or raw DEPS payloads.
- Every migration is checksum-tracked and forward-only. Production cutover and source destruction are outside this plan and require explicit authorization.
- Preserve the user's untracked `.env.local - Copia.example`; never stage it.

---

## Task 1: Pin Runtime Dependencies and Validate Configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`
- Create: `.env.example`
- Create: `docker-compose.dev.yml`
- Create: `src/lib/config.ts`
- Create: `src/lib/config.test.ts`

**Interfaces:**
- Consumes: process environment and Docker secrets exposed as environment variables.
- Produces: one frozen `config` object for database, auth, storage, antivirus, SMTP, and backup adapters.

- [ ] Install dependencies: `npm install better-auth@1.7.2 pg@8.21.0 qrcode@1.5.4` and `npm install --save-dev @types/pg@8.15.5 @types/qrcode@1.5.5 @playwright/test@1.62.1`.
- [ ] Write a failing `src/lib/config.test.ts` that proves startup rejects missing values, `BETTER_AUTH_SECRET` shorter than 32 characters, non-absolute `DOCUMENT_ROOT`, malformed URLs, and ClamAV ports outside 1–65535.
- [ ] Use this minimal valid fixture in the test:

```ts
const valid = {
  DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  DOCUMENT_ROOT: "D:/credit-system/.data/documents",
  CLAMAV_HOST: "localhost",
  CLAMAV_PORT: "3310",
};
```

- [ ] Run `npx vitest run src/lib/config.test.ts`; expect failure because `readConfig` is absent.
- [ ] Implement `readConfig(env)` with Node standard library: trim strings, reject absent values, parse URLs with `new URL`, validate `path.isAbsolute`, validate integer ports, freeze the result, and export `config = readConfig(process.env)`.
- [ ] Add `.env.example` containing names and safe local values only; no production secrets. Add `"type-check": "tsc --noEmit"` to package scripts.
- [ ] Add `docker-compose.dev.yml` with `postgres:18.6-alpine3.23` bound only to `127.0.0.1:54329`, `pg_isready`, a named database volume, and `clamav/clamav:1.4.6_base-debian13-slim` on an internal network.
- [ ] Change Docker build/runtime bases to `node:22.23.2-alpine3.23`; preserve the current Next.js standalone stages.
- [ ] Verify with `npx vitest run src/lib/config.test.ts`, `docker compose -f docker-compose.dev.yml config`, then start both services and inspect `docker compose -f docker-compose.dev.yml ps`.
- [ ] Commit only the listed files with `git commit -m "build: add postgres auth runtime"`.

---
## Task 2: Create the Checksum-Tracked PostgreSQL Schema

**Files:**
- Create: `scripts/db/migrate.mjs`
- Create: `scripts/db/migrate.test.mjs`
- Create: `db/migrations/001_roles.sql`
- Create: `db/migrations/002_auth.sql`
- Create: `db/migrations/003_business.sql`
- Create: `db/migrations/004_rls.sql`
- Create: `db/migrations/005_indexes.sql`
- Create then delete: `scripts/db/auth-schema.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: ordered SQL files and an owner-level migration URL.
- Produces: a repeatable schema and `schema_migrations(version, checksum, applied_at)` history.

- [ ] Write `scripts/db/migrate.test.mjs` with `node:test`: record a migration checksum, change its SQL, and assert that rerunning refuses the mismatch.
- [ ] Run `node --test scripts/db/migrate.test.mjs`; expect failure because the runner is absent.
- [ ] Implement the runner using Node `crypto`, `fs`, and `pg`: acquire `pg_advisory_lock(hashtext('credit-system-migrate'))`, run each new migration in a transaction, and reject changed SHA-256 checksums.
- [ ] In `001_roles.sql`, create/configure `schema_owner`, `app_runtime`, and `backup_reader`; explicitly use `NOBYPASSRLS` for runtime and `BYPASSRLS` plus read-only defaults for backup.
- [ ] Create a temporary CLI-only `scripts/db/auth-schema.config.ts` that calls `betterAuth({ database: new Pool({ connectionString: process.env.DATABASE_OWNER_URL }), emailAndPassword: { enabled: true }, plugins: [twoFactor()] })`. Generate with `npx auth@1.7.2 generate --config scripts/db/auth-schema.config.ts --output db/migrations/002_auth.sql --yes`, review it, then delete the temporary config. Keep user IDs as strings containing preserved Supabase UUIDs, unique case-insensitive email handling, and required TOTP tables.
- [ ] In `003_business.sql`, recreate all active tables and constraints represented by `supabase/migrations/*.sql`, preserving source UUIDs and timestamps. Exclude only confirmed-unused legacy tables `clients`, `authorizations`, and `notifications`, after the runbook records their source row counts.
- [ ] Create the canonical provider boundary exactly around these columns:

```sql
create table bureau_payloads (
  id uuid primary key,
  consultation_id uuid not null references consultations(id) on delete cascade,
  provider text not null check (provider = 'deps'),
  product text not null,
  received_at timestamptz not null,
  http_status integer not null check (http_status between 100 and 599),
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  validation_status text not null check (validation_status in ('valid','incompatible')),
  validation_errors jsonb not null default '[]'::jsonb,
  unique (consultation_id, payload_sha256)
);

create table bureau_results (
  consultation_id uuid primary key references consultations(id) on delete cascade,
  payload_id uuid not null unique references bureau_payloads(id),
  adapter_version integer not null check (adapter_version > 0),
  canonical_result jsonb not null,
  document text not null,
  person_name text,
  score integer,
  risk_level text,
  created_at timestamptz not null default now()
);
```

- [ ] Add `payload_incompatible` to consultation status constraints. Add indexes only for current access paths: owner/status/date, client/date, normalized document, payload consultation, and result document.
- [ ] In `004_rls.sql`, enable and force RLS on tenant/business tables. Policies derive identity from `current_setting('app.user_id', true)` and role from `current_setting('app.user_role', true)` and deny when either is absent.
- [ ] Grant owner DDL, runtime required DML only, and backup `SELECT` only. Add `db:migrate` and `db:migrate:test` scripts.
- [ ] Run `npm run db:migrate:test`, then `npm run db:migrate` twice against an empty local database; the second run must be a no-op.
- [ ] Commit the listed files with `git commit -m "feat: create postgres schema"`.

---

## Task 3: Add Transaction-Scoped Identity and Prove RLS Isolation

**Files:**
- Create: `src/lib/db/pool.ts`
- Create: `src/lib/db/transaction.ts`
- Create: `src/lib/db/permissions.ts`
- Create: `src/lib/db/rls.integration.test.ts`

**Interfaces:**
- Consumes: authenticated `{ userId, role }` plus a SQL callback.
- Produces: `withUserTransaction(identity, callback)` with transaction-local RLS context.

- [ ] Write an integration test with pool `max: 1`: seed two clients and consultants; prove each identity sees only permitted rows; reuse the same connection; prove identity does not leak after commit, rollback, or callback error.
- [ ] Run `npx vitest run src/lib/db/rls.integration.test.ts`; expect failure because the transaction helper is absent.
- [ ] Implement one singleton `pg.Pool` with connection/query timeouts and redacted errors.
- [ ] Implement this single transaction primitive; do not create repository interfaces:

```ts
export type DbIdentity = {
  userId: string;
  role: "admin" | "consultant" | "client";
};

export async function withUserTransaction<T>(
  identity: DbIdentity,
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T>;
```

- [ ] After `BEGIN`, call parameterized `select set_config('app.user_id', $1, true)` and `select set_config('app.user_role', $1, true)`. Commit only on success; otherwise roll back; always release.
- [ ] Define existing permissions as a literal union and role-to-permission constant. `hasPermission` handles capabilities; PostgreSQL handles row ownership.
- [ ] Verify with `npx vitest run src/lib/db/rls.integration.test.ts` and `npm run type-check`.
- [ ] Commit with `git commit -m "feat: enforce transaction scoped rls"`.

---

## Task 4: Replace the Supabase Auth Core with Better Auth

**Files:**
- Create: `src/lib/auth/config.ts`
- Create: `src/lib/auth/server.ts`
- Create: `src/lib/auth/client.ts`
- Create: `src/lib/auth/session.ts`
- Create: `src/lib/auth/authorization.ts`
- Create: `src/lib/auth/email.ts`
- Create: `src/lib/auth/auth.integration.test.ts`
- Create: `src/app/api/auth/[...all]/route.ts`

**Interfaces:**
- Consumes: email/password/TOTP requests and SMTP configuration.
- Produces: Better Auth handler, browser client, server session helper, password-reset email, and trusted application identity.

- [ ] Write integration tests proving: public signup is rejected; login creates a DB session; server idle over 30 minutes is rejected; absolute age over 24 hours is rejected; reset links expire after 15 minutes; staff without TOTP gets `mfa_setup_required`; and password/role changes revoke sessions.
- [ ] Run `npx vitest run src/lib/auth/auth.integration.test.ts`; expect failure.
- [ ] Configure Better Auth with PostgreSQL, email/password, TOTP, DB sessions, and DB rate limits. Set password length 12–128, scrypt, secure `__Host-` cookies in production, `trustDevice: false`, disabled public signup, and 24-hour absolute expiry.
- [ ] Implement 30-minute idle enforcement in `getRequiredSession()`: revoke stale sessions and update activity at most once per five minutes.
- [ ] Map the Better Auth string ID to the preserved profile UUID and return exactly `{ userId, role, permissions, mfaComplete }`; never accept a client-supplied role.
- [ ] Send reset links via existing SMTP settings; log only message ID and masked recipient.
- [ ] Expose the handler from `src/app/api/auth/[...all]/route.ts`.
- [ ] Run the auth test, generate `.tmp-auth-schema.sql`, and compare it with `db/migrations/002_auth.sql` using `git diff --no-index`; review every difference, then delete the temporary file.
- [ ] Commit with `git commit -m "feat: replace auth core with better auth"`.

---

## Task 5: Migrate Login, Middleware, User Administration, and MFA UI

**Files:**
- Modify: `src/actions/auth.ts`
- Modify: `src/actions/users.ts`
- Modify: `src/middleware.ts`
- Modify: `src/app/(auth)/**`
- Modify: `src/app/(dashboard)/settings/security/**`
- Modify: `src/app/(dashboard)/settings/users/**`
- Create: `src/app/(auth)/mfa/setup/page.tsx`
- Create: `src/app/(auth)/mfa/verify/page.tsx`
- Create: `e2e/auth.spec.ts`

**Interfaces:**
- Consumes: Better Auth client/server helpers from Task 4.
- Produces: complete password-reset onboarding and staff TOTP enrollment/verification flow.

- [ ] Install the matching local browser once with `npx playwright install chromium`. Add failing Playwright cases for login, forced password setup, mandatory staff TOTP, optional client TOTP, logout, reset-link expiry, admin invitation, disabled user, and open-redirect rejection.
- [ ] Run `npx playwright test e2e/auth.spec.ts`; confirm the old Supabase paths fail the new expectations.
- [ ] Replace Supabase calls in auth actions and pages with Better Auth. Validate redirect targets as same-origin paths.
- [ ] Change admin-created users to invitation/reset links; never generate or email temporary passwords.
- [ ] Use `qrcode` only to render the Better Auth `otpauth://` URI. Display recovery codes once, require the first valid TOTP before marking enrollment complete, and never persist secrets in client storage.
- [ ] Middleware performs only cookie-presence routing. Pages/actions call `getRequiredSession()` and `hasPermission()` for actual authorization.
- [ ] Revoke all sessions when an admin changes role/status or a user changes password. Record audit events without credential data.
- [ ] Run `npx playwright test e2e/auth.spec.ts`, relevant Vitest auth tests, and `npm run type-check`.
- [ ] Commit with `git commit -m "feat: migrate authentication flows"`.

---

## Task 6: Build the Versioned DEPS Canonical Adapter

**Files:**
- Create: `src/types/bureau.ts`
- Create: `src/lib/deps/adapter.ts`
- Create: `src/lib/deps/adapter.test.ts`
- Create: `src/lib/deps/__fixtures__/pf-current.json`
- Create: `src/lib/deps/__fixtures__/pf-legacy.json`
- Create: `src/lib/deps/__fixtures__/pj-current.json`
- Create: `src/lib/deps/__fixtures__/pj-legacy.json`
- Modify: `src/lib/deps/real.ts`

**Interfaces:**
- Consumes: `unknown` DEPS body plus `{ product, httpStatus, receivedAt }`.
- Produces: `AdaptResult = { ok: true; value: CanonicalBureauResult; version: 1 } | { ok: false; errors: AdapterError[]; version: 1 }`.

- [ ] Create anonymized fixtures from each real PF/PJ shape already represented in code/history. Keep structural variants but replace names, documents, phones, addresses, and identifiers.
- [ ] Define `CanonicalBureauResult` with stable sections actually rendered today: subject, document, score/risk, registration status, debts, protests, checks, queries, company ownership/participation, messages, and provider metadata. Optional sections are empty arrays or absent by contract, never shape-dependent unions.
- [ ] Write failing tests for all four fixtures, unknown additive fields, missing optional sections, numeric strings, null values, wrong root type, and missing required subject/document. Assert errors contain JSON paths but no payload values.
- [ ] Run `npx vitest run src/lib/deps/adapter.test.ts`; expect failure.
- [ ] Implement small runtime guards (`isRecord`, string/number/date coercion, bounded array reader) inside `adapter.ts`; no validation dependency and no unsafe whole-payload cast.
- [ ] Normalize CPF/CNPJ to digits, money to integer cents, timestamps to ISO strings, and scores to bounded integers. Preserve unrecognized fields only in raw storage, not the canonical result.
- [ ] Update `real.ts` to return `{ httpStatus, product, body: unknown, receivedAt }`. Redact URLs/query parameters and never log response bodies or documents.
- [ ] Run adapter tests, `npm run type-check`, and `rg -n "as (Deps|.*Response)|body as" src/lib/deps src/types`; no unsafe provider casts may remain.
- [ ] Commit with `git commit -m "feat: validate deps payloads"`.

---

## Task 7: Persist Consultations and Payloads Atomically

**Files:**
- Create: `src/lib/consultations/service.ts`
- Create: `src/lib/consultations/service.integration.test.ts`
- Modify: `src/actions/consultations.ts`
- Modify: `src/actions/scr.ts`
- Modify: `src/actions/company.ts`
- Delete: `src/lib/deps/map.ts`
- Delete: `src/lib/deps/protestos.ts`

**Interfaces:**
- Consumes: authorized consultation request and raw response from Task 6.
- Produces: immutable `bureau_payloads`, optional canonical `bureau_results`, and final consultation status in one controlled flow.

- [ ] Write integration tests proving: raw payload is stored before adaptation; SHA-256 is deterministic; valid canonical result and `completed` status commit together; incompatible payload stores errors and `payload_incompatible`; DB failure rolls back canonical/status changes; retries do not duplicate the same payload hash.
- [ ] Run `npx vitest run src/lib/consultations/service.integration.test.ts`; expect failure.
- [ ] Implement one `executeConsultation` domain function. Hash exact received JSON bytes when available; otherwise hash a deterministic UTF-8 JSON serialization created once before insert.
- [ ] Insert raw response immediately in a user-scoped transaction. Run the adapter. For success, insert canonical result and set `completed` in the same transaction; for incompatibility, update raw validation fields and set `payload_incompatible` without fabricating a result.
- [ ] Propagate network/provider failures into existing retry/error statuses without recording a fake HTTP response.
- [ ] Route consultation, SCR, and company actions through the service. Remove the two old mapping modules only after `rg -n "deps/map|deps/protestos" src` returns no consumers.
- [ ] Run the integration test, all DEPS tests, and `npm run type-check`.
- [ ] Commit with `git commit -m "feat: persist canonical bureau results"`.

---

## Task 8: Move UI, PDF, and AI to the Canonical Contract

**Files:**
- Modify: `src/app/(dashboard)/consultations/**`
- Modify: `src/lib/pdf/consultation-full-document.tsx`
- Modify: `src/lib/ai/prompt.ts`
- Modify: `src/actions/ai.ts`
- Create: `src/lib/consultations/view-model.ts`
- Create: `src/lib/consultations/view-model.test.ts`

**Interfaces:**
- Consumes: `CanonicalBureauResult` only.
- Produces: stable detail screen, batch/single PDFs, and redacted AI prompt data.

- [ ] Write a compact view-model test using the canonical PF/PJ fixtures. Assert missing optional sections render empty states, cents format correctly, and incompatible status never dereferences a result.
- [ ] Run `npx vitest run src/lib/consultations/view-model.test.ts`; expect failure.
- [ ] Implement one pure view-model function shared by page and PDF where practical. Keep React presentation separate; do not recreate provider-shape conditionals.
- [ ] Update consultation detail and batch/single PDF paths to query `bureau_results.canonical_result` and handle `payload_incompatible` with a safe support message plus consultation ID.
- [ ] Build AI input from an explicit canonical allow-list. Remove document numbers, addresses, phones, email, raw provider messages, and payload before calling OpenAI. Keep the existing user-visible behavior and model configuration.
- [ ] Run the view-model test, relevant component/PDF tests, `npm run type-check`, and `rg -n "raw_response|bureau_payloads.*payload|deps_response" src/app src/lib/pdf src/lib/ai src/actions/ai.ts`; consumers must not read raw payload JSON.
- [ ] Commit with `git commit -m "refactor: consume canonical bureau data"`.

---

## Task 9: Migrate CRM, Settings, Audit, and Dashboard Queries

**Files:**
- Create: `src/lib/clients/queries.ts`
- Create: `src/lib/settings/queries.ts`
- Create: `src/lib/audit/write.ts`
- Create: `src/lib/dashboard/queries.ts`
- Create: `src/lib/db/domain.integration.test.ts`
- Modify: `src/actions/clients.ts`
- Modify: `src/actions/settings.ts`
- Modify: dashboard server components that call Supabase

**Interfaces:**
- Consumes: session identity and validated action inputs.
- Produces: parameterized domain SQL under Task 3 transaction/RLS boundaries.

- [ ] Inventory exact callers with `rg -n "supabase|\.from\(|\.rpc\(" src/actions src/app`; add one integration assertion for each active mutation/read family before replacement.
- [ ] Run `npx vitest run src/lib/db/domain.integration.test.ts`; expect failure.
- [ ] Implement small functions per domain operation using parameterized SQL. Reuse existing action input validation and error messages. Do not expose `PoolClient` outside domain modules and do not create CRUD generators.
- [ ] Write audit events in the same transaction as the business mutation. Audit records are append-only to runtime roles and contain actor, action, target type/ID, timestamp, request correlation ID, and redacted metadata.
- [ ] Replace dashboard aggregates with direct SQL matching current filters/time zones; verify representative totals against seeded source-equivalent rows.
- [ ] Run domain integration tests, action tests, `npm run type-check`, and repeat the inventory command to enumerate only the Supabase paths intentionally left for later tasks.
- [ ] Commit with `git commit -m "feat: migrate core data access to postgres"`.

---

## Task 10: Replace Supabase Storage with Private Scanned Documents

**Files:**
- Create: `src/lib/documents/storage.ts`
- Create: `src/lib/documents/clamav.ts`
- Create: `src/lib/documents/service.ts`
- Create: `src/lib/documents/service.test.ts`
- Create: `src/app/api/documents/[id]/route.ts`
- Modify: `src/actions/opportunities.ts`
- Modify: `src/actions/portal.ts`
- Modify: document upload/download UI

**Interfaces:**
- Consumes: authenticated upload stream for PDF/JPEG/PNG up to 15 MiB.
- Produces: quarantined scan, private random file path, metadata row, and authorized streaming download.

- [ ] Write tests using temporary directories and a fake ClamAV TCP server: reject oversize files, extension/signature mismatch, polyglot prefix, traversal names, scanner timeout/error/infected result; accept known minimal clean signatures; prove unauthorized downloads return 404.
- [ ] Run `npx vitest run src/lib/documents/service.test.ts`; expect failure.
- [ ] Validate size while streaming. Validate signatures with Node buffers: PDF `%PDF-`, JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`. Ignore user filenames for paths; store display name only as sanitized metadata.
- [ ] Write to `DOCUMENT_ROOT/quarantine/<uuid>`, `fsync`, scan through ClamAV `INSTREAM`, and fail closed on timeout/unavailability. Move clean files atomically to `DOCUMENT_ROOT/objects/<first-two-id-chars>/<uuid>`; delete infected quarantine files and write an audit event.
- [ ] Persist SHA-256, byte size, detected MIME, object key, scan result/version, uploader, and timestamps. Never store absolute host paths in the database.
- [ ] Download route loads metadata inside RLS context, opens the known root/object key with traversal protection, returns safe `Content-Type`, `Content-Disposition`, `X-Content-Type-Options: nosniff`, and streams without buffering the whole file.
- [ ] Route opportunity and client portal uploads through this service; remove signed/public Supabase URLs.
- [ ] Run document tests, portal/opportunity tests, and `npm run type-check`.
- [ ] Commit with `git commit -m "feat: add private scanned document storage"`.

---

## Task 11: Remove Remaining Supabase Runtime Dependencies

**Files:**
- Create: `scripts/check-no-supabase.mjs`
- Modify: every remaining file reported by the static check
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `src/lib/supabase/client.ts`
- Delete: `src/lib/supabase/server.ts`
- Delete: `src/lib/supabase/middleware.ts`
- Delete: `src/lib/supabase/admin.ts`
- Delete: `src/types/supabase.ts`
- Move: `supabase/migrations/**` to `docs/legacy/supabase-migrations/**`

**Interfaces:**
- Consumes: repository source tree.
- Produces: build-time proof that production source and dependencies no longer use Supabase.

- [ ] Write a failing `node:test` around `scripts/check-no-supabase.mjs`. It must reject `@supabase/`, `NEXT_PUBLIC_SUPABASE_`, `SUPABASE_SERVICE_ROLE`, imports from `lib/supabase`, and runtime references under `src`; allow only `docs/legacy` and migration tooling that reads the old source during cutover.
- [ ] Run the check and capture the remaining file list.
- [ ] Replace each remaining active caller with the domain functions from Tasks 3–10. Do not emulate `.from()`, `.select()`, `.rpc()`, or Supabase query chaining.
- [ ] Remove Supabase packages and environment variables. Move historical SQL to `docs/legacy` so it remains auditable but cannot be mistaken for the active migration source.
- [ ] Run `node scripts/check-no-supabase.mjs`, `npm run type-check`, and `npm run build`.
- [ ] Commit with `git commit -m "refactor: remove supabase runtime"`.

---

## Task 12: Harden the Production Container Stack

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-stack.yml`
- Modify: `next.config.mjs`
- Create: `src/app/api/health/live/route.ts`
- Create: `src/app/api/health/ready/route.ts`
- Create: `src/app/api/health/health.test.ts`
- Create: `docker/postgres/init/001-users.sh`

**Interfaces:**
- Consumes: Docker Secrets, Traefik network, internal service network, persistent DB/document/ClamAV volumes.
- Produces: non-root read-only application container and private healthy services.

- [ ] Write health tests: liveness never performs external I/O; readiness runs `select 1`, verifies writable document root, and returns 503 without leaking exception details when a dependency fails.
- [ ] Run `npx vitest run src/app/api/health/health.test.ts`; expect failure.
- [ ] Run the app as a numeric non-root user, use a read-only root filesystem, mount only `/tmp` as `tmpfs`, and mount documents with the minimum required permissions.
- [ ] In `docker-stack.yml`, pin `postgres:18.6-alpine3.23`, `clamav/clamav:1.4.6_base-debian13-slim`, and the built application image by immutable release tag. PostgreSQL and ClamAV attach only to an encrypted internal overlay; only app attaches to Traefik.
- [ ] Mount runtime DB/auth/SMTP secrets only in the app, owner migration secret only in a one-shot migration service, and backup credentials only in backup service. No secret appears in image, Compose environment defaults, labels, or repository.
- [ ] Add Postgres health checks, restart policies, CPU/memory reservations, `stop_grace_period`, log rotation, and ClamAV memory sized to at least 4 GiB or measured signature-database requirement.
- [ ] Add security headers in Next config: CSP compatible with current assets, HSTS in production, frame denial, referrer policy, permissions policy, and `nosniff`. Verify auth cookies remain `Secure`, `HttpOnly`, `SameSite=Lax`, and `__Host-` scoped.
- [ ] Verify `docker compose -f docker-stack.yml config`, build the image, inspect its configured user, start locally, and probe both health endpoints in healthy and failed-dependency states.
- [ ] Commit with `git commit -m "build: harden production containers"`.

---

## Task 13: Add Encrypted Daily Backup and Restore Testing

**Files:**
- Create: `docker/backup/Dockerfile`
- Create: `docker/backup/backup.sh`
- Create: `docker/backup/restore-test.sh`
- Create: `docker/backup/prune.sh`
- Create: `docker/backup/crontab`
- Create: `docker/backup/backup.test.sh`
- Modify: `docker-stack.yml`

**Interfaces:**
- Consumes: read-only backup DB credentials, document volume, Restic repository/password, S3 credentials, SMTP alert configuration.
- Produces: encrypted off-site snapshots, retention enforcement, restore-test report, and failure alert.

- [ ] Build a test harness with temporary Restic local backend and disposable PostgreSQL. Assert a snapshot contains a custom-format dump, manifest, and document tree; corrupt/miss a dump and prove restore test fails.
- [ ] Run `sh docker/backup/backup.test.sh`; expect failure.
- [ ] Build a small multi-stage image containing PostgreSQL 18 client, `restic/restic:0.18.1`, POSIX shell, and the existing SMTP command-line client. Do not run Docker-in-Docker.
- [ ] `backup.sh` acquires a filesystem lock, runs `pg_dump --format=custom --no-owner --no-privileges`, writes a SHA-256 manifest, then runs one Restic snapshot containing dump plus documents. A failed dump must never produce a successful snapshot marker.
- [ ] `prune.sh` runs `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune` only after a successful snapshot.
- [ ] `restore-test.sh` restores the latest snapshot into an empty temporary location/database, verifies manifest hashes, runs `pg_restore`, checks required tables/count queries, opens sampled files by hash, and emails success/failure with snapshot ID but no secrets/PII.
- [ ] Schedule backup daily at 02:30 server local time and restore test at 04:00 on day 1 monthly. This meets the agreed 24-hour RPO; document that recovery time depends on measured data size.
- [ ] Require S3 bucket versioning and deny public access in the operator checklist. Mount backup role and S3/Restic secrets only into backup service.
- [ ] Run the harness twice, inspect `restic snapshots`, then commit with `git commit -m "ops: add encrypted offsite backups"`.

---

## Task 14: Build Repeatable Export, Import, and Preservation Verification

**Files:**
- Create: `scripts/migration/export-supabase.mjs`
- Create: `scripts/migration/import-postgres.mjs`
- Create: `scripts/migration/copy-storage.mjs`
- Create: `scripts/migration/verify.mjs`
- Create: `scripts/migration/lib.mjs`
- Create: `scripts/migration/migration.test.mjs`
- Create: `docs/operations/migration-rehearsal.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: read-only Supabase DB/storage access and empty target schema.
- Produces: immutable export manifest, preserved target rows/files, verification report, and rerunnable rehearsal.

- [ ] Write tests with a tiny source fixture containing fixed UUIDs/timestamps, one user, one client, one valid consultation/raw payload, one incompatible payload, one audit event, and two documents. Assert target IDs/timestamps/hashes/counts match and rerun is idempotent.
- [ ] Run `node --test scripts/migration/migration.test.mjs`; expect failure.
- [ ] Export active business rows in dependency order as newline-delimited JSON plus a manifest containing source table counts, min/max timestamps, and file metadata. Export identity metadata only: user UUID, normalized email, name, role/status, created/updated timestamps; exclude every legacy secret/token/session.
- [ ] Stream storage objects to disk while hashing; never buffer whole buckets. Record missing/unreadable objects as fatal verification errors.
- [ ] Import with `COPY`/parameterized SQL inside explicit transactions, preserving UUIDs and timestamps. For each preserved identity, use Better Auth's server-side admin API to create the user with a fresh cryptographically random 32-byte password, discard that plaintext immediately, retain no legacy credential, and mark the profile `must_reset_password = true`. Generate standard one-time reset links only during authorized cutover.
- [ ] Convert historical raw payloads through adapter version 1. Valid shapes create canonical results; invalid shapes remain preserved and become `payload_incompatible` with structural errors.
- [ ] Verify exact row counts for active tables, all foreign keys, unique emails/documents, consultation-result consistency, source/target file SHA-256, audit append-only state, and absence of imported password/session/MFA data. Exit nonzero for any discrepancy.
- [ ] Add npm scripts `migration:export`, `migration:import`, and `migration:verify` that require explicit source/target URLs; print redacted connection hosts only.
- [ ] Rehearse twice from fresh target volumes using a sanitized full-size export. Record elapsed export/import/verification/backup times, disk usage, ClamAV memory, and the exact downtime estimate in `docs/operations/migration-rehearsal.md`.
- [ ] Commit with `git commit -m "ops: add repeatable data migration"`.

---

## Task 15: Add Release Gates, Rollback Rehearsal, and Cutover Runbook

**Files:**
- Create: `scripts/verify-release.mjs`
- Create: `docs/operations/cutover.md`
- Create: `docs/operations/rollback.md`
- Create: `docs/operations/security-checklist.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed Tasks 1–14 and rehearsal evidence.
- Produces: one release command and operator-approved, reversible cutover procedure.

- [ ] Implement `npm run verify:release` to run formatting/lint, type check, unit/integration tests, Playwright auth/consultation/document smoke tests, production build, no-Supabase check, migration checksum check, Docker config validation, clean-schema migration, and migration verification. Stop on first failure.
- [ ] Run it before writing runbook claims; record actual duration and any environment prerequisites.
- [ ] Write `cutover.md` with exact ordered commands: announce maintenance, reject new writes, capture final Supabase DB/storage export, hash manifest, stop old app, create fresh target, migrate schema, import, verify, create encrypted backup, start new app, run smoke checks, issue reset links, monitor, and declare completion.
- [ ] Define go/no-go gates: zero migration verification errors; clean restore test; staff TOTP flow passes; client login/reset passes; DEPS current and legacy fixtures pass; documents upload/download/scan pass; RLS isolation passes; health/readiness passes.
- [ ] Write `rollback.md`: stop new app, preserve failed target volumes/logs, restart untouched old stack against unchanged Supabase source, verify old health/login/query, and communicate rollback. Never reverse-copy partial target writes into Supabase.
- [ ] Rehearse rollback once after a deliberately failed smoke gate and record recovery time. Keep the Supabase project and original storage read-only/untouched until a later, separately authorized retirement window.
- [ ] Write the security checklist covering secret generation/rotation, firewall, Traefik TLS, S3 versioning/private access, restore evidence, DB role inspection, RLS inspection, file permissions, log redaction, TOTP enforcement, and patch ownership.
- [ ] Run `npm run verify:release` from a clean working tree and save its terminal output outside the repository as release evidence.
- [ ] Commit with `git commit -m "docs: add postgres cutover runbook"`.

---

## Execution Stop Condition

Implementation is complete when Tasks 1–15 pass and the two migration rehearsals plus one rollback rehearsal have recorded evidence. Stop before production maintenance mode, final export, reset-link issuance, DNS/Traefik switch, or Supabase retirement. Those actions require the user's explicit cutover authorization.
