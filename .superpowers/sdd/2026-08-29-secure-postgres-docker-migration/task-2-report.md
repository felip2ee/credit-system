# Task 2 Report — Checksum-Tracked PostgreSQL Schema

## Status

Implementation complete for static and unit-testable scope. PostgreSQL execution remains an explicit integration gate because this host has neither a running Docker daemon nor local PostgreSQL binaries.

No Supabase source migration or source data was deleted or changed.

## Current data, readers, and writers

The inventory used `supabase/migrations/*.sql`, `src/types/supabase.ts`, and all `.from(...)` call sites under `src`.

| Source domain | PostgreSQL target | Current readers | Current writers | Preservation decision |
|---|---|---|---|---|
| `auth.users` + `profiles` | Better Auth `user`/`session`/`account`/`verification`/`two_factor` + `profiles` | auth actions/middleware, `actions/users.ts`, `actions/portal.ts`, settings pages | auth/user/portal actions | `profiles.id` stays UUID; `auth_user_id` is FK text and must equal the UUID string; passwords/sessions/TOTP are intentionally not imported |
| `queries` | `consultations` | consultation/company/SCR/AI/opportunity actions; consultation, batch, client and PDF pages | consultation/company/SCR/opportunity actions | IDs, timestamps, active status values and FKs preserved; `payload_incompatible` added |
| `query_results_pf`, `query_results_pj` | `bureau_payloads`, `bureau_results` | consultation/company/SCR/AI actions and detail/PDF/batch consumers | consultation/company/SCR actions | raw payloads move to immutable evidence; normalized consumers move to one canonical JSON result in later tasks |
| `batches`, `company_reports` | same names | company actions and batch/PDF pages | company actions | UUIDs, timestamps and batch/report relationship preserved |
| `crm_clients`, `crm_client_documents`, `crm_client_relations` | same names | client/company/consultation/opportunity/portal/SCR actions and dashboard pages | client/company/opportunity/portal actions | active CRM identity, documents, relationships and FKs preserved |
| `scr_authorizations` | same name | consultation, company, SCR and self-authorization actions | same action families | consent timestamps, token, channel, document and consultation relationship preserved |
| `ai_reports` | same name | AI/opportunity actions and consultation pages/PDFs | AI actions | complete report fields, review data and timestamps preserved |
| `opportunities`, `opportunity_documents` | same names | opportunity/portal actions and pages | opportunity/portal actions | active pipeline, document metadata and relationships preserved |
| `timeline_events`, `crm_notes` | same names | client/opportunity pages and action families | client/consultation/company/SCR/AI/opportunity/portal actions | append-only timeline grant retained; note IDs/timestamps retained |
| `settings` | same name | settings/AI/company/SCR actions | settings actions | key/value data and timestamps preserved; source rows are imported later rather than duplicated by schema seeds |
| `audit_logs` | same name, additive safe metadata fields | audit settings page | `src/lib/audit.ts` | source columns retained; outcome/request ID/redacted metadata added; runtime has INSERT but no UPDATE/DELETE |
| `credit_products` | same name | opportunity actions/pages | source migration seeds only | IDs and rows are imported later; no target-side duplicate seed rows |

### Legacy exclusion proof

The exact source search below returned no matches outside generated types:

```text
rtk rg -n --glob 'src/**' --glob '!src/types/supabase.ts' '\.from\("clients"\)|\.from\("authorizations"\)|\.from\("notifications"\)' src
```

Therefore `clients`, `authorizations`, and `notifications` are not recreated. Their rows remain in the source database/encrypted dump. Source row counts could not be queried on this host and remain a mandatory pre-cutover runbook gate; no source contraction is authorized by this task.

## Forward and rollback path

Forward path follows expand/migrate/verify/contract:

1. **Expand:** apply checksum-tracked migrations to an empty target and create isolated roles, Better Auth tables, active business tables, the canonical bureau boundary, forced RLS, narrow grants, and current indexes.
2. **Migrate:** a later task imports active source rows while retaining UUIDs/timestamps/FKs and maps `queries` to `consultations` plus wide raw results to payload/result records.
3. **Verify:** compare active counts, status totals, FK orphans, payload hashes, representative access paths, role capabilities and a second no-op migration run.
4. **Contract:** not performed. Supabase source migrations/data remain intact until separately authorized after rehearsal and cutover.

Rollback is operational, not a destructive down migration: stop target writes, route the application back to the unchanged Supabase deployment, diagnose/rebuild the disposable target, and retry forward. Applied migration files are immutable; checksum drift or removal is rejected.

## Implementation

- `scripts/db/migrate.mjs` discovers ordered `NNN_name.sql` files, hashes exact UTF-8 SQL with SHA-256, acquires `pg_advisory_lock(hashtext('credit-system-migrate'))`, checks history, and applies each pending file with its history insert in one transaction.
- `schema_migrations(version, checksum, applied_at)` is bootstrapped before versioned migrations. Changed checksums and missing applied files fail closed.
- `001_roles.sql` creates/configures `schema_owner`, `app_runtime NOBYPASSRLS`, and read-only `backup_reader BYPASSRLS`; database/schema public privileges are revoked and object ownership is transferred to `schema_owner`.
- `002_auth.sql` is derived from the Better Auth 1.7.2 generated schema for email/password plus `twoFactor()`. It includes current 1.7.2 `issuer`, TOTP verification/failure/lock fields, UUID-string user IDs, and a unique `lower(email)` index.
- `003_business.sql` preserves active domains and adds the canonical bureau boundary. Evidence columns are immutable; validation metadata can transition once from `pending` to `valid` or `incompatible`.
- `004_rls.sql` enables and forces RLS on every business table. Every policy requires both transaction-local `app.user_id` and `app.user_role`. Client access is limited to its own CRM row, opportunities, opportunity documents, and opportunity timeline. Profile identity/security fields and raw bureau evidence are protected by triggers plus narrow grants.
- `005_indexes.sql` contains only the requested live paths: owner/status/date, client/date, normalized consultation document, payload consultation, and result document.
- `package.json` exposes `db:migrate` and `db:migrate:test`.

## Better Auth 1.7.2 confirmation

The required temporary config used exactly `betterAuth({ database: new Pool({ connectionString: process.env.DATABASE_OWNER_URL }), emailAndPassword: { enabled: true }, plugins: [twoFactor()] })` and was deleted after generation/review.

The requested SQL-generation command loaded the installed API correctly but could not introspect PostgreSQL:

```text
rtk npx auth@1.7.2 generate --config scripts/db/auth-schema.config.ts --output db/migrations/002_auth.sql --yes
Error running Better Auth CLI: Error: connect ECONNREFUSED 127.0.0.1:54329
```

To confirm the package-owned schema without pretending a database, the same CLI/config generated its PostgreSQL Drizzle representation with `--adapter drizzle --dialect postgresql`. Review confirmed tables `user`, `session`, `account`, `verification`, `two_factor`; `account.issuer`; `user.two_factor_enabled`; encrypted `secret`/`backup_codes`; `verified`; `failed_verification_count`; `locked_until`; and the generated indexes/FKs. The temporary generated artifact was deleted. A direct CLI SQL diff remains an integration gate when PostgreSQL is available.

## TDD evidence

Production mutation caught before implementation: removing checksum comparison would allow an already-applied SQL file to change silently.

RED:

```text
rtk proxy node --test scripts/db/migrate.test.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/db/migrate.mjs'
tests 1; pass 0; fail 1
```

Second RED before the forward-only guard:

```text
rejects an applied migration missing from disk
AssertionError: Missing expected exception.
tests 2; pass 1; fail 1
```

GREEN:

```text
rtk npm run db:migrate:test
tests 2; pass 2; fail 0
```

Tests use the real filesystem, Node SHA-256 implementation and runner planning logic; there is no fake PostgreSQL client.

## Commands and outputs

```text
rtk proxy node --check scripts/db/migrate.mjs
# exit 0, no output

rtk npm run db:migrate:test
tests 2; pass 2; fail 0

rtk npm run type-check
tsc --noEmit
# exit 0

rtk npm test
Test Files 6 passed (6)
Tests 47 passed (47)

rtk docker info
Server: failed to connect to the docker API ... dockerDesktopLinuxEngine

rtk proxy where.exe psql
could not locate files for the given pattern

DATABASE_OWNER_URL=postgres://schema_owner:test@127.0.0.1:54329/credit_system rtk npm run db:migrate
connect ECONNREFUSED 127.0.0.1:54329

rtk git diff --check
# exit 0, no output
```

## Files

- `scripts/db/migrate.mjs`
- `scripts/db/migrate.test.mjs`
- `db/migrations/001_roles.sql`
- `db/migrations/002_auth.sql`
- `db/migrations/003_business.sql`
- `db/migrations/004_rls.sql`
- `db/migrations/005_indexes.sql`
- `package.json`
- this report

Temporary files removed: `scripts/db/auth-schema.config.ts`, `.tmp-auth-schema.ts`.

## Verification not executed / concerns

1. Empty PostgreSQL apply, second no-op apply, SQL execution/syntax, real ownership/grants, trigger behavior, and cross-tenant RLS behavior were not run because PostgreSQL is unavailable. Required gate: start an empty PostgreSQL 18 target, set `DATABASE_OWNER_URL`, run `npm run db:migrate` twice, then run role/RLS integration tests.
2. The Better Auth CLI SQL output must be regenerated against that target and diffed with `002_auth.sql`; only the package-generated PostgreSQL Drizzle schema could be reviewed here.
3. Source counts—including the three unused legacy tables—must be recorded from Supabase before rehearsal/cutover. Their absence here is not evidence of zero rows.
4. Database role passwords are deliberately not committed in migrations. Bootstrap/dev/prod must inject them via Docker secrets or an out-of-repository provisioning step.
5. Current application code still reads Supabase `queries`/wide result tables. Compatibility facades were intentionally not added; later planned tasks migrate those consumers before cutover.
