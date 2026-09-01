# Task 11e report — Contract Supabase runtime

## Pre-contraction inventory

`npm run check:no-supabase` was run before deletion. It failed only for the four reserved infrastructure files:

- `src/lib/supabase/{admin,client,middleware,server}.ts`

The active-caller check therefore passed. Repository inventory classified remaining references as: preserved historical SQL in `docs/legacy`; historical design/plan records; the no-Supabase checker and its fixtures; a non-runtime `skills-lock.json` source declaration; and an obsolete external-project helper at `supabase/check_migrations.sql`. No active `src` import, package, environment variable, network endpoint, or client factory remained.

## Upload policy decision

Task 11d used `role: "consultant"` after proving portal ownership, which made a client upload run with staff-wide document access. This is removed.

`007_client_document_upload.sql` is forward-only. It keeps the real `client` identity and permits an update only to a pre-existing owned, non-approved document slot. RLS requires ownership, `uploaded`/`clean` state, and the session user as uploader; a trigger permits only scanned upload metadata and rejects altered slot identity, label, relationship, review fields, or arbitrary row data. Narrow client audit/timeline policies preserve the upload audit/event flow; a guarded `new` → `documentation` progression preserves automatic document workflow without allowing other opportunity fields/statuses. The RLS integration regression verifies own-slot metadata success, label rejection, and another client's slot invisibility.

## Contracted runtime and preservation proof

- Deleted the four Supabase runtime clients and `src/types/supabase.ts`.
- Moved `supabase/migrations/001..011` to `docs/legacy/supabase-migrations/` with `git mv`; contents are unchanged (100% renames / zero content diff).
- Removed `@supabase/ssr`, `@supabase/supabase-js`, their lockfile tree, Supabase env samples, and Docker runtime env entries.
- Did not alter the external Supabase project, source data, storage, UUIDs, timestamps, users, documents, payloads, reports, or audit history.

Forward path: PostgreSQL/Better Auth/private document runtime plus migration `007`. Rollback path: deploy the prior commit, keep the untouched external source, and retain the historical SQL under `docs/legacy`; no source destruction or production cutover occurred.

## RED / GREEN

- RED: new client-upload RLS regression could not reach PostgreSQL (`ECONNREFUSED ::1/127.0.0.1:54329`), so no false/mock pass was added.
- GREEN static gates: `check:no-supabase` reports zero active references; checker and migration static tests pass 11/11; type-check passes.

## Commands and gates

- `npm run check:no-supabase` — PASS.
- `node --test scripts/check-no-supabase.test.mjs scripts/db/migrate.test.mjs` — PASS, 11/11.
- `npm run type-check` — PASS.
- `npm test` — 131 passed; six real-PostgreSQL suites unavailable with the exact connection refusal above (31 skipped after failed setup).
- `docker compose -f docker-stack.yml config` — exit 0; only unset deployment-variable and obsolete-compose-version warnings.
- Whole-repository Supabase inventory and package-lock search — no active runtime dependency; classifications recorded above.
- `git diff --check` — PASS.
- `npm run build` — started Next 14.2.35 and remained at `Creating an optimized production build ...` for over ten minutes, with no `BUILD_ID` or error output; terminated as a hung local process. Re-run this gate in CI/a non-hung Windows environment.

## Remaining gates

Apply `007_client_document_upload.sql` with the owner migration URL, then run the RLS/integration suites against real PostgreSQL and a completed production build. No database or external Supabase mutation was performed here.

## Review fix 1 — security gaps closed

### Changes

- Portal invitations now create/link the Better Auth user and profile, then request Better Auth's expiring reset link. The shared password, credential-account writes, password email, and `portal-invite-email.ts` are removed.
- `008_public_scr_authorization.sql` adds two forward-only, `SECURITY DEFINER` token/channel functions owned by the existing no-login `auth_profile_lookup` role. Both use a fixed safe search path, schema-qualified objects, revoked `PUBLIC` execute, and only `app_runtime` execute grants. Confirmation locks, validates, mutates, clears the code, and emits the one SCR timeline event in one database operation.
- Public SCR query functions now call those parameterized boundaries; the manual transaction and early-return leak are gone.
- Removed the unscanned browser-storage callback and its only query helper after repository search found no callers.

### RED / GREEN and verification

- RED: `src/actions/portal.test.ts` initially failed because `requestPasswordReset` had zero calls. GREEN: it passes and proves the reset-link request occurs while the password email boundary is not called.
- Focused unit tests: `src/actions/portal.test.ts` and `src/lib/scr/queries.test.ts` pass, 2/2.
- `npm run type-check`, `npm run db:migrate:test` (3/3), `npm run check:no-supabase`, and `git diff --check` pass.
- Extended `src/lib/db/rls.integration.test.ts` covers valid/unknown token reads, channel isolation, invalid-code non-mutation, authorize/refuse, replay rejection, and direct table invisibility. Its real execution remains blocked by `ECONNREFUSED ::1/127.0.0.1:54329` and `127.0.0.1:54329`; no skip or mock was added.
- The one reattempted build compiled and type-checked, then failed while collecting route data because this environment has no `BETTER_AUTH_SECRET`. It did not hang and is an environment configuration gate, not a suppressed pass.

### Remaining gates

Apply migrations through `008_public_scr_authorization.sql` with the owner URL, supply the production build environment (including `BETTER_AUTH_SECRET`), and run the real PostgreSQL RLS suite. The external Supabase source and all source data remain untouched.
