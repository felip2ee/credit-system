# Task 7 report — Persist Consultations and Payloads Atomically

## Status: DONE_WITH_CONCERNS

TDD followed: `service.integration.test.ts` written first as a real test (no skips,
no pass-faking mocks — the DEPS client is the only stubbed seam), then `service.ts`
implemented to satisfy it, then the 3 actions rewired.

## What was built

### `src/lib/consultations/service.ts` (new)
`executeConsultation({ identity, consultationId, entityKind, consult })`:

1. Calls `consult()` **outside** any transaction. A pre-response network/provider
   throw propagates untouched — no `bureau_payloads` row with a fabricated HTTP
   response.
2. `canonicalJson()` — one deterministic UTF-8 serialization (recursively
   sorted keys, `undefined` dropped like `JSON.stringify`). Exact received bytes
   are not available (`real.ts` already did `res.json()`), so this is the
   "build one deterministic serialization before insert and hash that" branch.
   `payloadSha256()` = SHA-256 of that string. The same string is what is stored
   in `payload` jsonb, so stored bytes and hash always agree.
3. In `withUserTransaction(identity, ...)`:
   - `insert into bureau_payloads (... 'pending')` with
     `on conflict (consultation_id, payload_sha256) do nothing returning id`.
     No row back → retry of the same payload → returns `{ status: "idempotent" }`,
     nothing else touched.
   - `adapt(raw.body, ...)`.
   - `ok:false` → `update bureau_payloads set validation_status='incompatible',
     validation_errors=<adapter errors, JSON paths only>` + `update consultations
     set status='payload_incompatible'`. No `bureau_results` row. Returns
     `{ status: "payload_incompatible", errors }`.
   - `ok:true` → `update bureau_payloads set validation_status='valid'` +
     `insert into bureau_results (consultation_id, payload_id, adapter_version,
     canonical_result, document, person_name, score, risk_level)` (derived from
     the canonical value) + `update consultations set status='completed',
     document_name, consulted_at, historico_consulta_id, api_version`. Returns
     `{ status: "completed", canonical }`.
   - Any failure in those writes throws → `withUserTransaction` rolls back the
     whole thing, including the raw-payload insert (single transaction).

Column writes stay inside the `app_runtime` grants in `004_rls.sql`
(`bureau_payloads` update limited to `validation_status`/`validation_errors`;
insert-only `bureau_results`).

### `src/lib/consultations/service.integration.test.ts` (new)
`describe.sequential`, pool is `max:1` (from `src/lib/db/pool.ts`), env bootstrapped
via `vi.hoisted` like `rls.integration.test.ts`. Seeds one `user` + `profiles`
row and 5 `consultations`. Proves every brief bullet:
- deterministic hash regardless of key order (pure, runs without a DB);
- raw payload stored + canonical result + `completed` commit together
  (asserts `bureau_payloads` row, `validation_status='valid'`, `bureau_results`
  derived fields, `consultations.status='completed'`);
- incompatible payload → `validation_status='incompatible'`, non-empty
  `validation_errors` with no payload value leaked, `payload_incompatible`
  status, no `bureau_results` row;
- DB failure after the raw insert (second, different payload collides on the
  `bureau_results` PK) → whole tx rolls back, only the first payload survives,
  status unchanged;
- retry with the same payload → `idempotent`, still one `bureau_payloads` row;
- pre-response network failure → propagates, no `bureau_payloads` row, status
  still `processing`.

### Actions rewired (bureau consult + persist path only)
- `src/actions/consultations.ts` — `runConsultation` and `reprocessQuery`.
- `src/actions/scr.ts` — `verifyScr` (added a local `currentUserId()` helper).
- `src/actions/company.ts` — `consultExistingMember` (dropped its now-unused
  `admin` service-client param).

All three now call `executeConsultation` instead of
`hasMappableResult` / `mapPfResult` / `mapPjResult` / `resultDisplayName` +
`admin.from("query_results_p{f,j}").insert(...)`. Display name now comes from
`outcome.canonical.subject.name`. The legacy "200 with empty mix → pending"
guard is replaced by the adapter's fail-closed `payload_incompatible` outcome,
per the context deliverable. Unrelated Supabase CRUD in these files
(client lookup, CRM writes, SCR bookkeeping, timeline, `recordAudit`,
`generateCompanyReport`'s reads of `query_results_*`) was left for Tasks 9/11.

### Supporting change
`DepsRawConsult` moved from `src/lib/deps/real.ts` into `src/types/deps.ts`
(re-exported from `real.ts` for compat) and `DepsClient.consultPF/consultPJ`
retyped to `Promise<DepsRawConsult>` — the interface was still declaring the
pre-Task-6 `DepsConsultResult*` shape, which would otherwise have made the new
persist path type-red.

### Deleted
`src/lib/deps/map.ts` + `src/lib/deps/map.test.ts`. `rg -n "deps/map" src` now
returns only a prose reference inside `src/lib/ai/parecer-prompt.md` (an AI prompt
template, not a code consumer) — left untouched to avoid changing prompt behavior.
`src/lib/deps/protestos.ts` was **kept** (Task 7 ruling — its consumers are all
Task 8 files).

## Verify results
- `npx vitest run src/lib/deps` — green, 3 files / 18 tests.
- `npm run type-check` — 4 carried errors, all the legacy Supabase `queries`
  enum (see concerns). Nothing else.
- `rg -n "deps/map" src` — no code consumers (one prompt-template comment).

## Concerns
1. **Deferred integration run.** `npx vitest run
   src/lib/consultations/service.integration.test.ts` was NOT executed — the
   Docker Postgres daemon is not running in this environment. Authored per the
   Task 3 integration-gate ruling; execution deferred to the Task 15 release gate.
2. **Carried type-check errors (legacy Supabase `queries` path, TS2322 on the
   `payload_incompatible` literal):**
   - `src/actions/company.ts:236`
   - `src/actions/consultations.ts:279`
   - `src/actions/consultations.ts:374`
   - `src/actions/scr.ts:148`
   These are `supabase.from("queries").update({ status: "payload_incompatible" })`
   shim writes — the checked-in Supabase generated types predate the
   `consultation_status` enum in `db/migrations/003_business.sql`. Consistent with
   the context scope-guard ("type-check may stay red on those files' remaining
   Supabase paths — carried"). The new `consultations` status is written correctly
   inside `executeConsultation`; these lines only keep the legacy `queries` row in
   sync until Tasks 9/11 migrate the actions off Supabase. `service.ts`, the test,
   and the transactional persist path itself are type-clean.
3. Semantic change (intended, per deliverable): a DEPS 200 with an empty `mix`
   (SCR not yet authorized) now resolves to `payload_incompatible` rather than the
   old `pending_scr`. The SCR-pending UX nuance is a Tasks 9/11 concern once the
   actions are fully on Postgres.
