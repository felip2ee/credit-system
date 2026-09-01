# Task 11d report

## Inventory and behavior

- `src/actions/portal.ts`: Supabase admin/auth, CRM, document, timeline and audit calls were replaced by Better Auth credentials plus explicit PostgreSQL transactions.
- `src/lib/auth.ts`: `getCurrentProfile` and `isAdmin` now derive their identity from the Better Auth session, deny by default, and expose the existing `Profile` shape.
- `src/lib/audit.ts`: legacy `recordAudit` maps callers to the PostgreSQL append-only writer using the authenticated session. New portal mutations write audit records in their mutation transaction.
- Portal listing uses `src/lib/portal/queries.ts`; PostgreSQL RLS scopes rows to the signed-in client. Opportunity detail already used the RLS query and keeps clean-document filtering.
- `/auth/callback` no longer exchanges a Supabase code. Its legacy landing redirect is constrained to the request origin.
- Authorized downloads now require `scan_result = 'clean'` in addition to RLS visibility.

## RED / GREEN

- RED: callback test failed because `safeRedirectPath` did not exist. GREEN: same-origin and hostile absolute redirects pass.
- RED: auth helper test failed because the prior Supabase client threw outside request scope. GREEN: unauthenticated access returns `null`.
- RED: audit mapping test failed because the PostgreSQL event mapper did not exist. GREEN: caller fields map to actor/action/target/outcome/metadata.
- RED: portal query integration test failed because `listPortalOpportunities` did not exist. GREEN implementation is present; its real PostgreSQL execution is blocked by the unavailable daemon (no mock or skip added).

## Commands and output

- `npm test -- src/app/auth/callback/route.test.ts src/lib/auth.test.ts src/lib/audit.test.ts`: 3 files / 3 tests passed.
- `npm run type-check`: passed.
- `npm test`: 131 passed; six real-PostgreSQL suites failed in `beforeAll` with `ECONNREFUSED ::1/127.0.0.1:54329`, including the new portal integration test.
- `npm run check:no-supabase`: reports exactly the four Task 11e-reserved infrastructure files: `src/lib/supabase/{admin,client,middleware,server}.ts` (script exits non-zero by design).
- `npm run build`: reached `Creating an optimized production build ...`; command did not finish inside the 30-second execution window.
- `git diff --check`: passed.

## Files

- Modified: portal actions/layout/home, legacy callback, auth/audit helpers, secure document route.
- Added: portal query module and integration test; focused callback, auth helper, and audit mapping tests.

## Concerns

- Docker/PostgreSQL is unavailable locally, so real RLS/audit/portal integration assertions could not execute.
- Production build needs a longer-running environment to complete its Next.js optimization phase.
- The existing RLS policy permits client document reads but not writes. Uploads therefore re-check ownership under the real client identity, then use a narrowly scoped server write identity; replace it with a client upload policy when the migration-owned slice is available.
