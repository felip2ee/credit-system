# Task 9 report — Migrate CRM, Settings, Audit, and Dashboard Queries

Status: DONE_WITH_CONCERNS
Branch: feature/secure-postgres-migration
Commit: feat: migrate core data access to postgres (hash below)

## What changed

### New domain modules (parameterized SQL under `withUserTransaction` / RLS; no `PoolClient` escapes)
- `src/lib/audit/write.ts` — `writeAuditEvent(client, event)` writes an append-only
  `audit_logs` row **in the caller's transaction**. Fields: actor (`user_id` = session
  user, RLS-enforced), action, target table/id, `outcome`, `request_id`
  (`requestCorrelationId()` from `x-request-id` / `x-correlation-id` / `x-vercel-id`,
  uuid fallback), redacted `metadata` (`redact()` masks any `cpf|cnpj|document|
  password|senha|secret|token|auth_code|hash|api_key` key to `***xx`). Replaces the
  Supabase `recordAudit` for migrated flows; the old `src/lib/audit.ts` stays for the
  Task 10/11 Supabase sweep (still imported by out-of-scope `users.ts`, `company.ts`,
  `scr.ts`, `scr-self.ts`, `opportunities.ts`, `consultations.ts`).
- `src/lib/clients/queries.ts` — `createClientRecord`, `updateClientRecord`,
  `updateClientStatus`, `addClientNote`, `linkPartner` (each opens its own
  transaction, writes timeline event + audit event atomically); reads `listClients`,
  `getClientDetail`, `getClientForEdit`. Business conflicts return
  `{ ok:false, reason }` (`duplicate_document` / `self_link` / `already_linked`);
  everything else throws and rolls back.
- `src/lib/settings/queries.ts` — `readSetting`, `readSettings`, `upsertSettings`,
  `deleteSettings` (each writes an audit event). `jsonb` value round-trips via
  `JSON.stringify` + `$::jsonb`.
- `src/lib/dashboard/queries.ts` — `getDashboardMetrics(identity, {startToday,
  startMonth, start6mo})` runs the aggregates as direct SQL (`count(*) filter (…)`
  over `consultations`, sub-selects for scr/clients/ai/batches, raw rows for
  opportunities/scr/ai/monthly). Numeric columns cast `::float8`, counts `::int`.
  `getConsultantNames(identity, ids)` for the admin table. The Brasília-timezone
  boundary math stays in the page (unchanged).

### Migrated off Supabase
- `src/actions/clients.ts` — all mutations now go through `src/lib/clients/queries.ts`
  behind `getRequiredSession()` + `hasPermission(role, "clients:write")`. Input
  validation (`clientSchema`) and user-facing strings kept verbatim
  ("Já existe um cliente com este documento.", "Sessão expirada.", "CPF do sócio
  inválido.", "Informe o nome do sócio.", "Não é possível vincular o cliente a ele
  mesmo.", "Sócio já vinculado.", …). `lookupCnpj` untouched (external fetch only).
- `src/actions/settings.ts` — AI prompts, commission rate, SCR term settings all read
  via `readSetting(s)` and written via `upsertSettings`/`deleteSettings`. Admin gate
  is now `hasPermission(role, "settings:write")`; the three admin-only strings kept
  verbatim. `getAiPrompt`/`getScrTermSettings`/`getCommissionRate` signatures
  unchanged for their out-of-scope callers.
- `src/app/(dashboard)/layout.tsx` — `getRequiredSession().catch(() =>
  redirect("/login"))`; `role === "client"` → `/portal`; Topbar email via a
  1-row `profiles` query.
- `src/app/(dashboard)/page.tsx` — `getDashboardMetrics` + `getConsultantNames`.
- `src/app/(dashboard)/settings/audit/page.tsx` — direct `audit_logs` + `profiles`
  left-join query; admin gate + `redirect`. Reads `metadata` (falls back to legacy
  `new_data`).
- `src/app/(dashboard)/clients/page.tsx`, `clients/[id]/page.tsx`,
  `clients/[id]/edit/page.tsx` — `getClientDetail` / `listClients` /
  `getClientForEdit`.
- `src/app/(dashboard)/settings/page.tsx`, `settings/commission/page.tsx`,
  `settings/prompts/page.tsx`, `settings/scr/page.tsx` — `getCurrentProfile`/`isAdmin`
  → `getRequiredSession()` + `role === "admin"`. This unblocks the Task 5
  settings/security + settings/users pages (they already used `getRequiredSession`).

### Task 8 carried minor
- `summarizeProtestos` (+ its `ProtestoOcorrencia`/`ProtestosSummary` types) inlined
  into `src/lib/deps/adapter.ts`; `src/lib/deps/protestos.ts` +
  `src/lib/deps/protestos.test.ts` deleted. `countProtestos` had no remaining
  consumer (only the deleted test) → dropped. `rg -n "deps/protestos" src` clean.

### Tests
- `src/lib/db/domain.integration.test.ts` — Vitest, pool `max:1`, RLS-scoped
  transactions, real DB (no skips/mocks; `next/headers` mocked to force the audit
  correlation-id fallback). One assertion per migrated mutation/read family:
  createClientRecord (+ dup reject), update record/status, addClientNote, linkPartner
  (+ dup link), listClients filter, settings round-trip, `writeAuditEvent` redaction
  + append-only (delete rejected), `getDashboardMetrics` counts. Authored real,
  execution deferred (see concerns).

## Commands

```
npm run type-check
  → only the 4 carried Task 7 errors:
    src/actions/company.ts(255,17)  TS2322 "payload_incompatible"
    src/actions/consultations.ts(292,17) TS2322 "payload_incompatible"
    src/actions/consultations.ts(408,19) TS2322 "payload_incompatible"
    src/actions/scr.ts(158,17)      TS2322 "payload_incompatible"
  All new + migrated Task 9 files type-clean.

rg -n "deps/protestos" src           → clean
rg -n "deps/protestos|countProtestos|summarizeProtestos" src
  → only src/lib/deps/adapter.ts (definition + internal use)

npx vitest run src/lib/deps          → 2 files, 15 passed  (adapter protest
                                        assertions green — inline OK)
npx vitest run src/lib/deps src/lib/consultations
  → deps + consultations unit tests green (21 passed).
    src/lib/consultations/service.integration.test.ts fails on
    `connect ECONNREFUSED …:54329` — the pre-existing deferred DB gate
    (Task 7), not a regression: the deps tests that exercise the inlined
    adapter all pass.
```

## Deviations / decisions

- `countProtestos` dropped (dead after `protestos.test.ts` deletion) rather than
  carried into `adapter.ts`.
- Old `src/lib/audit.ts` and `src/lib/auth.ts` left in place — still imported only by
  out-of-scope files (`(portal)/**`, `users.ts`, `company.ts`, `scr*.ts`,
  `opportunities.ts`, `consultations.ts`). Per ruling, Task 11's Supabase sweep.
- Audit row: `record_id` is `uuid`-typed, so settings audit events pass
  `targetId: null` and carry the key(s) in `metadata` instead.
- `updateClientStatus` / `addClientNote` previously surfaced raw Supabase
  `error.message`; now return fixed Portuguese strings ("Falha ao alterar o status.",
  "Falha ao salvar a anotação.").

## Concerns (carry forward)

1. **Carried type-check paths (not mine, die with Supabase in Task 11):**
   `src/actions/company.ts:255`, `src/actions/consultations.ts:292`,
   `src/actions/consultations.ts:408`, `src/actions/scr.ts:158` — legacy `queries`
   enum missing `payload_incompatible`.
2. **Remaining Supabase inventory (intentionally left for Tasks 10/11):**
   actions — `opportunities.ts`, `company.ts`, `portal.ts`, `scr.ts`, `scr-self.ts`,
   `ai.ts`, `users.ts` (auth-only helper paths), `auth.ts`, remaining
   `consultations.ts` paths;
   app — `(portal)/layout.tsx`, `(portal)/portal/page.tsx`,
   `(portal)/portal/oportunidades/[id]/page.tsx`, `auth/callback/route.ts`,
   `(auth)/mfa|reset-password|update-password/page.tsx`,
   `(dashboard)/opportunities/{page,[id]/page}.tsx`, `(dashboard)/scr/page.tsx`,
   `(dashboard)/consultations/{page,[id]/page,[id]/pdf/route,export/route}.tsx`,
   `(dashboard)/batch/{page,[id]/page,[id]/pdf/route}.tsx`,
   `(dashboard)/settings/security/page.tsx`.
   `src/lib/auth.ts` + `src/lib/audit.ts` still wrap Supabase.
3. **Deferred integration run:** `npx vitest run src/lib/db/domain.integration.test.ts`
   cannot run here (no Docker Postgres daemon on :54329). Authored real, no
   skips/mocks; execution deferred to the Task 15 release gate, consistent with
   Tasks 3/7.
4. **Out-of-scope callers now need a request session:** `getAiPrompt` (ai.ts),
   `getScrTermSettings` (scr actions) now call `getRequiredSession()` internally. Fine
   inside a server-action request; if Task 10/11 calls them from a bg job without
   request scope they'll throw — those files are Task 10/11's to reconcile.
