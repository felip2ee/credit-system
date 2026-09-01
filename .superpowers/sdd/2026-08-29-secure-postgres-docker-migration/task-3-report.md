# Task 3 Report: Transaction-Scoped Identity and RLS Isolation

## Status

DONE_WITH_CONCERNS. The transaction primitive, singleton pool, permission matrix, and real integration test are implemented. The integration gate remains unproven because PostgreSQL is not listening on the configured local test port.

## RED-GREEN-REFACTOR

### RED

1. Ran `npx vitest run src/lib/db/rls.integration.test.ts` after creating the real integration test and before production code.
   - Expected failure observed: `Cannot find module '/src/lib/db/pool'` imported by `rls.integration.test.ts`.
2. Wrote `permissions.test.ts` before restoring `permissions.ts`.
   - Expected failure observed: `Cannot find module './permissions'`.

The RLS test uses the actual `pg` pool and database tables: it creates an admin, two consultants, two clients, and two CRM rows. It asserts each client can see only its own row, staff can see both rows, a single backend connection is reused, and `app_context_present()` is false after commit, SQL rollback, and a callback exception. No database or driver behavior is mocked.

### GREEN

Implemented:

- `pool.ts`: one `pg.Pool`, `max: 1`, five-second connection timeout, ten-second query timeout, and a generic pool error log that does not emit an error payload.
- `transaction.ts`: `withUserTransaction()` begins a transaction, sets both identity values through parameterized transaction-local `set_config` calls, commits only after successful work, rolls back any started transaction on failure, and always releases the client.
- `permissions.ts`: literal `Permission` union, immutable role matrix, and deny-by-default `hasPermission` lookup.

`npx vitest run src/lib/db/permissions.test.ts` passes: 1 test passed.

### REFACTOR

No additional abstraction was introduced. The only cleanup was splitting the integration assertions into real helper functions for visible rows and connection context, plus separate SQL rollback and callback-error paths.

## Commands and Results

| Command | Result |
| --- | --- |
| `npx vitest run src/lib/db/rls.integration.test.ts` (RED) | Failed as expected: transaction modules absent. |
| `npx vitest run src/lib/db/permissions.test.ts` (RED) | Failed as expected: permission module absent. |
| `npx vitest run src/lib/db/permissions.test.ts` (GREEN) | Passed: 1 test. |
| `npx vitest run src/lib/db/rls.integration.test.ts` | Failed before test execution: `ECONNREFUSED ::1:54329` and `127.0.0.1:54329`; PostgreSQL/Docker is unavailable. |
| `npm test` | 48 passed, 2 skipped; suite fails only from the same RLS integration connection refusal. |
| `npm run type-check` | Passed (`tsc --noEmit`). |
| `git diff --check` | Passed before staging. |
| `git diff --cached --check` | Passed after staging all Task 3 files. |

## Files

- `src/lib/db/pool.ts`
- `src/lib/db/transaction.ts`
- `src/lib/db/permissions.ts`
- `src/lib/db/permissions.test.ts`
- `src/lib/db/rls.integration.test.ts`

## Commit

`feat: enforce transaction scoped rls`

## Self-Review

Reviewed the complete diff against the Task 3 requirements. Findings: none. The context is set only after `BEGIN`, `true` scopes both settings to that transaction, neither success nor either error path can retain a checked-out client, and `app_runtime` continues to rely on PostgreSQL RLS for ownership enforcement.

## Concerns and Gates Not Executed

- The required real RLS integration gate is blocked, not skipped: no PostgreSQL process accepts connections on port 54329, and Docker/psql remain unavailable.
- Consequently, schema migration, `app_runtime` role/ownership checks, actual RLS visibility, rollback cleanup, and same-backend reuse require rerun in the disposable PostgreSQL environment.
- No production deployment, migration, or Docker command was attempted.

## Fix Round 1/5

### Fix Changes

- `transaction.ts`: if `ROLLBACK` itself fails, `withUserTransaction()` now releases the `pg` client with that error (or `true` for a non-`Error` rejection), causing `pg` to discard the potentially contaminated connection. The original callback/query error remains the rejection.
- `transaction.test.ts`: regression test proves a rollback failure invalidates the client and does not replace the original failure.
- `permissions.test.ts`: covers all 42 role-permission decisions (every permission for admin, consultant, and client).
- `rls.integration.test.ts`: asserts `identities.admin` can read both seeded client rows, in addition to the existing consultant/client checks.

### RED/GREEN

- RED: `npx vitest run src/lib/db/transaction.test.ts src/lib/db/permissions.test.ts` failed the new transaction regression exactly as expected: it received `rollback failed` instead of the callback error; the prior implementation also called `release()` without the rollback error. The expanded permission matrix was already green because its production mapping was correct; no artificial mutation was made to manufacture a RED state.
- RED environmental gate: the real RLS integration test, including the new admin assertion, could not execute because PostgreSQL refused both `::1:54329` and `127.0.0.1:54329`.
- GREEN: after the transaction patch, the focused suite passed: 43/43 tests.

### Commands and Results

| Command | Result |
| --- | --- |
| `npx vitest run src/lib/db/transaction.test.ts src/lib/db/permissions.test.ts` (RED) | 1 expected transaction failure; 42 permission decisions passed. |
| `npx vitest run src/lib/db/rls.integration.test.ts` | Environmental gate blocked: `ECONNREFUSED ::1:54329` and `127.0.0.1:54329`. |
| `npx vitest run src/lib/db/transaction.test.ts src/lib/db/permissions.test.ts` (GREEN) | 2 files, 43/43 passed. |
| `npm test` | 90 passed, 2 skipped; suite fails only from the same unavailable PostgreSQL RLS integration gate. |
| `npm run type-check` | Passed (`tsc --noEmit`). |
| `git diff --check` | Passed. |

### Self-Review

`release(error)` is the `pg` pool invalidation path and is used only when rollback cannot establish transaction cleanup. Successful commits and successful rollbacks still call the normal no-error release. The matrix uses literal expected decisions rather than reusing the production role map; the admin integration assertion reads real RLS-protected rows.

### Concerns

- PostgreSQL/Docker remains unavailable locally, so the new admin visibility assertion and the complete RLS flow require rerun in the disposable PostgreSQL environment.
