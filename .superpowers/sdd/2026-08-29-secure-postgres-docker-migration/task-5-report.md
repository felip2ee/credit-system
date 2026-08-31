# Task 5 report — Migrate Login, Middleware, User Administration, MFA UI

## Status: DONE_WITH_CONCERNS

## What was done (built on the existing uncommitted WIP)

### Finished / fixed WIP
- `src/components/auth/mfa-enrollment.tsx` — fixed type errors against better-auth 1.7.2
  (`twoFactor.enable` returns a `{method}` union; narrow with `"totpURI" in data`;
  `verifyTotp` result has no `.status`, check `result.data`).
- `src/middleware.ts` — `publicPaths` now uses `/mfa`, `/mfa/setup`, `/mfa/verify`
  (RULING: route group `(auth)` adds no URL prefix). Still cookie-presence routing only.
- `src/actions/users.ts` — added `recordAudit` events for invite / role change /
  activate / deactivate (no credential data). Invitation flow already used
  `auth.api.requestPasswordReset`; no temp passwords.
- `src/components/settings/create-user-form.tsx` — removed temp-password display;
  success panel now shows "Convite enviado".
- `e2e/auth.spec.ts` — URL assertion changed from `/auth/mfa/(setup|verify)` to
  `/mfa/(setup|verify)`.

### Migrated (were still Supabase)
- `src/app/(auth)/update-password/page.tsx` — now `authClient.resetPassword({ newPassword, token })`
  with `token` from the query string; missing/bad token surfaces
  "...O link pode ter expirado." (e2e expectation). Min password length 12.
- `src/app/(dashboard)/settings/security/page.tsx` — replaced the Supabase MFA
  enroll/challenge/verify UI with `<MfaEnrollment>`.
- `src/app/(dashboard)/settings/users/page.tsx` — auth gate now
  `getRequiredSession()` + `hasPermission(role, "users:manage")`; user list read via
  `withUserTransaction(session, ...)` instead of the Supabase client.

### Created
- `src/app/(auth)/mfa/setup/page.tsx` — renders `<MfaEnrollment>` (forced staff TOTP
  enrollment), `onComplete` -> `/`. Has a "Sair" (signOut) button.
- `src/app/(auth)/mfa/verify/page.tsx` — TOTP code entry via
  `authClient.twoFactor.verifyTotp`; "Sair" button. (This is the migrated form of the
  old `mfa/page.tsx` Supabase `MfaVerifyPage`.)
- `src/app/(auth)/mfa/page.tsx` — reconciled: now a server redirect to `/mfa/verify`.

## Deviation (outside the brief's Files list)
- `src/lib/auth/client.ts` — `twoFactorClient({ twoFactorPage })` changed from the
  stale `/auth/mfa` to `/mfa/verify`. Required for the two-factor redirect to land on a
  real route under the RULING. One line; staged with Task 5.

## Commands run
- `npx tsc --noEmit` — clean, no output (baseline had 5 errors, all in Task 5 WIP files).
- `npx vitest run src/lib/auth` — `src/lib/auth/server.test.ts` passes (3 passed, 9
  skipped). `src/lib/auth/auth.integration.test.ts` fails at `beforeAll` with
  `ECONNREFUSED 127.0.0.1:54329` — no Postgres available in-loop. Pre-existing, identical
  before my changes; same deferral class as the live Playwright run.
- `npx playwright install chromium` — already present.
- `npx playwright test e2e/auth.spec.ts --list` — compiles, 4 tests listed.

## Concerns
1. Live Playwright execution deferred to the Task 15 release gate (needs seeded Postgres
   + running app). No skips/mocks added.
2. `src/lib/auth/auth.integration.test.ts` cannot pass without a live DB on :54329 —
   pre-existing, not introduced here.
3. `(dashboard)/layout.tsx` still authenticates via Supabase `getCurrentProfile`, so the
   two migrated `settings/*` pages are only reachable once Tasks 9/11 migrate the layout.
   Left untouched per the scope guard.
4. No `playwright.config.ts` in the repo; `--list` works via the CLI path arg. Config +
   web-server wiring is a Task 15 concern.
5. `recordAudit` still writes through the Supabase service client (Task 9/11 territory);
   it is best-effort/silent, so the audit calls are harmless no-ops until that migrates.
