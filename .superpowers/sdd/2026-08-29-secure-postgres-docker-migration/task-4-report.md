# Task 4 — Better Auth Core

## Status

`DONE_WITH_CONCERNS` — the Better Auth core, PostgreSQL schema mappings, server
session enforcement, scoped profile lookup, SMTP reset delivery, and Next.js
route are implemented and type-checked. PostgreSQL is unavailable in this
workspace, so the real database lifecycle tests and Better Auth schema
comparison remain a deployment gate.

## Better Auth 1.7.2 API verification

Verified from installed `node_modules`:

```text
{"version":"1.7.2","betterAuth":"function","toNextJsHandler":"function"}
```

The inspected 1.7.2 implementation supports the supplied `pg.Pool`,
`rateLimit.storage: "database"`, UUID ID generation, email/password settings,
TOTP, `toNextJsHandler`, and default Node `crypto.scrypt` password hashing.
The two-factor plugin has no `trustDevice: false` option in this version; the
server handler therefore rejects every TOTP/OTP/backup-code verification
request that sends `trustDevice: true`, which enforces the required stricter
policy without trusting a client setting.

## Delivered behavior

- Public email/password signup is disabled; passwords are limited to 12–128
  characters and use Better Auth's default scrypt hash.
- Sessions and rate limits are database-backed. Session expiry is absolute at
  24 hours; `getRequiredSession()` revokes 30-minute-idle sessions and writes
  activity at most every five minutes.
- Production cookies are host-only `__Host-credit-system.*`, `HttpOnly`,
  `Secure`, `SameSite=Lax`, and `Path=/`; only the configured app origin is
  trusted. Production IP proxy headers trust only `TRAEFIK_PROXY_CIDR`.
- Password change, reset/recovery, role change, and deactivation revoke
  sessions. Staff without enabled TOTP receives `mfa_setup_required`; client
  TOTP remains optional.
- Better Auth IDs are generated as UUID strings and are resolved through the
  preserved `profiles.auth_user_id`. No role supplied by a browser is accepted.
- The `auth_profile_for_session(text)` SECURITY DEFINER function returns only
  `{ user_id, role, is_active, mfa_enabled }`. Its non-login owner has only the
  required profile columns and `BYPASSRLS`, because `profiles` is FORCE RLS;
  `app_runtime` has execute-only access. The existing direct profile policy
  remains deny-by-default and has an integration assertion.
- Password-reset mail uses `src/lib/config.ts` SMTP settings and logs only the
  mail message ID plus a masked recipient. No legacy credential, session,
  reset, recovery, or MFA secret is imported.

## RED → GREEN evidence

1. RED: before the auth modules existed,
   `npx vitest run src/lib/auth/auth.integration.test.ts` failed at module
   resolution for `./authorization`.
2. GREEN without PostgreSQL: the transport test now passes and
   `npx vitest run src/lib/config.test.ts` passes 16/16, including the new
   production Traefik-CIDR guard.
3. The real lifecycle suite covers disabled signup, database login/session,
   idle and absolute expiry, 15-minute single-use recovery, recovery/password
   session revocation, staff MFA, role revocation, and deactivation revocation.
   It deliberately uses the real pool and Better Auth handler—there is no fake
   database adapter.

## Commands and results

| Command | Result |
| --- | --- |
| `npx vitest run src/lib/config.test.ts` | PASS — 16 tests |
| `npx vitest run src/lib/auth/auth.integration.test.ts` | 1 transport test passed; 9 lifecycle tests skipped after `beforeAll` failed to connect to PostgreSQL |
| `npx vitest run src/lib/db/rls.integration.test.ts` | blocked before setup by the same connection error |
| `npm test` | 92 passed, 12 skipped; 2 database suites failed only with `ECONNREFUSED` |
| `npm run type-check` | PASS |
| `git diff --check` | PASS |
| `npm run build` with safe verification environment values | PASS (exit 0); pre-existing ESLint warning cannot resolve `next/core-web-vitals` |

Database failures are concrete: `connect ECONNREFUSED ::1:54329` and
`connect ECONNREFUSED 127.0.0.1:54329`.

The Better Auth generator available in npm is `@better-auth/cli@1.4.21`
(there is no CLI release `1.7.2`). The required command was attempted:

```text
npx @better-auth/cli@1.4.21 generate --config src/lib/auth/server.ts --output .tmp-auth-schema.sql --yes
```

It reached PostgreSQL introspection and failed with the same `ECONNREFUSED`.
No `.tmp-auth-schema.sql` was generated, so `git diff --no-index` could not be
run and there was no temporary file to delete.

## Files

- Added: `src/lib/auth/{config,server,client,session,authorization,email}.ts`,
  `src/lib/auth/auth.integration.test.ts`, and
  `src/app/api/auth/[...all]/route.ts`.
- Updated: `src/lib/config.ts`, `src/lib/config.test.ts`,
  `db/migrations/001_roles.sql`, `db/migrations/002_auth.sql`,
  `db/migrations/004_rls.sql`, and `src/lib/db/rls.integration.test.ts`.

## Remaining gates / concerns

1. Start the PostgreSQL test service on port 54329, apply migrations, then run
   the auth and RLS integration suites, `npm test`, the Better Auth generator,
   and `git diff --no-index .tmp-auth-schema.sql db/migrations/002_auth.sql`.
2. Review every generator difference before accepting any schema adjustment;
   do not import protected legacy-auth data.
3. Legacy Supabase consumers remain outside this Task 4 file scope and must be
   migrated by their owning follow-up task before removing Supabase packages.
