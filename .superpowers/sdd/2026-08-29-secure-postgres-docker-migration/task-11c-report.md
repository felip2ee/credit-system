# Task 11c report

## Inventory

Before: 192 Supabase reads/writes across the 11 listed action/page/route files and `src/lib/deps/scr-auth.ts`. They covered consultation creation/retry/list/detail/export/PDF, company batches and reports, SCR verification/self-consent, and AI reports.

After: zero Supabase imports, `.from(...)`, or `.rpc(...)` calls in that slice. The global no-Supabase check reports only the ten expected 11d/11e files (`portal`, legacy auth/audit and Supabase infrastructure).

## Implementation

- Added parameterized PostgreSQL domain access in `src/lib/company/queries.ts`, `src/lib/scr/queries.ts`, and consultation read helpers.
- Actions/pages use `getRequiredSession`, `hasPermission`, `withUserTransaction`, `executeConsultation`, and canonical `bureau_results.canonical_result` reads.
- Removed legacy consultation dual writes; added `payload_incompatible` to the application status contract and badge/label mapping.
- SCR self confirmation performs a locked conditional write, clears the authorization code, and refuses already-completed/replayed tokens.
- Company and AI reports read canonical results only; no provider/raw result tables are read.

## RED / GREEN

- RED: `src/lib/scr/queries.test.ts` initially failed because `./queries` did not exist.
- GREEN: `rtk npm test -- src/lib/scr/queries.test.ts` passes (1 test).

## Commands and results

- `rtk npm run type-check`: pass.
- `rtk npm test`: 128 pass; five real PostgreSQL integration suites fail with `ECONNREFUSED ::1/127.0.0.1:54329` because Docker/PostgreSQL is unavailable; no mocks/skips added.
- `rtk npm run check:no-supabase`: expected fail, only ten 11d/11e references remain.
- `rtk npm run build`: completed without emitted error output.
- `rtk git diff --check`: pass.

## Files

Modified actions, consultation/SCR pages and routes, `src/lib/deps/scr-auth.ts`, and the query status contract. Added company/SCR/consultation PostgreSQL query modules and the focused SCR regression test.

## Concerns / shared interfaces

`executeConsultation`, `CanonicalBureauResult`, session/permission, settings, SMTP, and existing UI action interfaces remain callable. Public SCR token reads/writes require the deployed RLS policy to permit the intentionally unauthenticated confirmation flow; this cannot be validated while PostgreSQL is down. Audit parity should be verified against the live RLS schema during the integration gate.
