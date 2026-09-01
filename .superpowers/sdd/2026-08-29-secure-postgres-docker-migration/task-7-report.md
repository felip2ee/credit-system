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

---

## Fix round 1

### IMPORTANT 1 — empty-`mix` 200 no longer drops SCR-pending bookkeeping
`executeConsultation` now returns a third outcome, `no_data`, distinct from
`payload_incompatible`. Discriminator (`service.ts` `isNoData`): the adapter
failed with `root_not_object` or `missing_identity` → no recognizable subject
identity block → the DEPS "documento sem dados / SCR ainda não autorizado" case
(old `deps/map.ts` `hasMappableResult`). Any other adapter failure = real data
that failed schema validation.

- `no_data`: raw payload is still stored (immutable evidence), left at
  `validation_status='pending'`; **consultation status is not touched**. Callers
  route it to the existing recovery path:
  - `consultations.ts` `runConsultation` → `markPending()` (status
    `pending_authorization`, `upsertScrAuthorization({status:"pending"})`, email
    persist to `crm_clients`, `scr.requested` timeline event).
  - `consultations.ts` `reprocessQuery` → `queries.status='pending_authorization'`
    + pending-SCR message (mirrors the old reprocess behaviour, which never did
    the full `upsertScrAuthorization`).
  - `scr.ts` `verifyScr` → `stayPending()` (scr row back to `pending`,
    `last_checked_at` bumped, returns `{status:"pending"}`). Caller and DB now
    agree — no more `{status:"pending"}` while writing `'payload_incompatible'`.
  - `company.ts` `consultExistingMember` → `markPending()`.
- `payload_incompatible` (real data, failed schema): unchanged — payload
  `'incompatible'` + JSON-path errors, `consultations.status='payload_incompatible'`,
  and the legacy `queries` dual-write. Actions now return a hard error
  ("dados incompatíveis com o formato esperado do bureau") rather than a
  soft pending. `verifyScr` returns `{status:"not_authorized"}` here.
- Retry of an already-stored payload: no writes; the terminal outcome is
  re-derived from the pure adapter (`terminal()`), so a `no_data` / incompatible
  retry is classified correctly instead of a blanket "idempotent".

### IMPORTANT 2 — `queries` `completed` dual-write restored
All four success paths (`runConsultation`, `reprocessQuery`, `verifyScr`,
`consultExistingMember`) again write
`supabase.from("queries").update({ status:"completed", document_name,
consulted_at, historico_consulta_id, api_version })` after `executeConsultation`
commits. Values come from the canonical result
(`outcome.canonical.subject.name` / `.provider.*`). `product_version`,
`is_partial`, `share_link` are no longer available from the canonical shape and
are left unset (not load-bearing; the whole dual-write is deleted at Task 9/11).
Matches the migration dual-write pattern the `payload_incompatible` branch
already used.

### MINOR fixes
3. `service.ts`: extracted `sha256Of(serialized)`, reused for both
   `payloadSha256()` and the insert hash.
4. Action callers derive identity from `getRequiredSession()` (a new
   `currentIdentity(): Promise<DbIdentity | null>` helper per action file,
   mirroring the existing `currentUserId` pattern) — `{ userId, role }` from the
   session instead of a hardcoded `role: "consultant"`. A non-staff role now
   fails closed at the RLS boundary.
5. **Not applied — cannot.** `004_rls.sql:270-273` grants `app_runtime` INSERT
   only on `(id, consultation_id, provider, product, received_at, http_status,
   payload, payload_sha256)`; naming `validation_status` in the INSERT column
   list raises `permission denied for column validation_status`. The value is
   pinned by the column `DEFAULT 'pending'` + the CHECK constraint + the
   `enforce_bureau_payload_transition` trigger (which rejects any first
   transition that is not `pending → valid|incompatible`), so relying on the
   default is the only correct option here.
6. `company.ts` `processCompanyMember` status map: added
   `payload_incompatible: "error"` so a re-dispatched batch member row no longer
   returns `"skipped"`.

### Test changes
`service.integration.test.ts`: `incompatibleBody` is now an identity block with a
wrong-typed `nome` (real data → `payload_incompatible`); added `noDataBody`
(no identity → `no_data`) and a new case asserting the payload is stored
`'pending'` with the consultation status untouched; the retry case now asserts
the re-derived `completed` outcome.

### Verify — commands + output

```
$ npm run type-check
> tsc --noEmit
src/actions/company.ts(255,17): error TS2322: Type '"payload_incompatible"' is not assignable to type '"completed" | "rejected" | "processing" | "pending_authorization" | "authorized" | "error" | undefined'.
src/actions/consultations.ts(292,17): error TS2322: Type '"payload_incompatible"' is not assignable to type ... .
src/actions/consultations.ts(408,19): error TS2322: Type '"payload_incompatible"' is not assignable to type ... .
src/actions/scr.ts(158,17): error TS2322: Type '"payload_incompatible"' is not assignable to type ... .
```
Same 4 carried errors as round 1 — all `supabase.from("queries").update({status:"payload_incompatible"})`
on the stale Supabase-generated `queries` enum (Tasks 9/11 remove these writes).
`service.ts`, the test, and the transactional persist path are type-clean.

```
$ npx vitest run src/lib/deps src/lib/consultations
 ❯ src/lib/consultations/service.integration.test.ts (7 tests | 7 skipped)
 FAIL  src/lib/consultations/service.integration.test.ts > executeConsultation
 Error: connect ECONNREFUSED 127.0.0.1:54329
 Test Files  1 failed | 3 passed (4)
      Tests  18 passed | 7 skipped (25)
```
`src/lib/deps` — 18/18 green. The integration suite cannot connect to Postgres
(no Docker daemon) — execution deferred to the Task 15 release gate, as before.

## Concerns (round 1)
1. Deferred integration run → Task 15 (unchanged).
2. 4 carried type-check errors, legacy Supabase `queries` enum:
   `src/actions/company.ts:255`, `src/actions/consultations.ts:292`,
   `src/actions/consultations.ts:408`, `src/actions/scr.ts:158`. Permitted by the
   context scope-guard; removed at Tasks 9/11.
3. MINOR 5 not applied — column-level INSERT grant forbids it; see above.
