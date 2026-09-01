# Task 8 report — Move UI, PDF, AI to the Canonical Contract

## Status: DONE_WITH_CONCERNS

TDD followed: `view-model.test.ts` written first, confirmed failing (module not
found), then `view-model.ts` implemented until green.

## What was built

### `src/lib/consultations/view-model.ts` (new)
- `toConsultationView(c: CanonicalBureauResult): ConsultationView` — one pure
  function. Formats cents→BRL strings, dates→pt-BR, derives `empty` flags per
  optional section, splits `debts.items` into `debts` (informante) vs `lawsuits`
  (`source === "acao_judicial"`) — the Task 6 merged-section carried minor,
  handled here, not in the adapter. Filters generic provider messages
  (`ok`/`sucesso`/…) out of `messages`, keeps "Nada consta".
- `incompatibleView(consultationId): IncompatibleView` — `{ incompatible: true,
  consultationId, message }`. No result parameter, cannot dereference a result.
- `formatSubjectDocument(c)` — formatted CPF/CNPJ, kept OUT of `toConsultationView`
  so the redacted AI path never pulls a document number in transitively.
- No provider-shape conditionals (`row.smart_*`, `Mod<T>`, `.mix`, wide columns).

### `src/lib/consultations/view-model.test.ts` (new)
7 cases via the canonical PF/PJ fixtures (`adapt()`-ed) + hand-built inputs:
subject/score/cents formatting, ownership present vs participation empty, capital
formatting, **all optional sections → empty states**, generic-message filtering,
debt/lawsuit split, and `incompatibleView` never touching a result (with a
`@ts-expect-error` guard proving the type carries no result fields).

### `src/lib/consultations/canonical-store.ts` (new)
`loadCanonicalResult(identity, consultationId)` — `select canonical_result from
bureau_results where consultation_id = $1` inside `withUserTransaction`
(RLS-scoped). Returns `null` when no row (payload_incompatible / not-yet-backfilled).

### `src/lib/pdf/consultation-full-document.tsx`
Deleted the entire provider-shape type block (`Mod<T>`, `Metrica`, `ScrItem`,
`ScrTotalBlock`, `PfMix`, `ComportamentalIndicador`) and the Smart / SCR / renda /
faturamento / contatos / emails / outrosEnderecos sections (not in the canonical
contract — Task 6 ruling). `FullConsultationPage` / `renderFullConsultationPdf`
now take `view: ConsultationView`. Kept the letterhead, score bar, section/table
infra. Renders: identity, score, restrições cards, ownership, participation,
queries, lawsuits, debts, protests, cheques, bureau messages, AI opinion.
`summarizeProtestos` import removed.

### `src/lib/pdf/company-process-document.tsx`
`CompanyProcessEntry.mix: PfMix` → `.view: ConsultationView`; passes `view=` down.

### `src/app/(dashboard)/consultations/[id]/page.tsx`
Dropped `buildView` + `countProtestos` + `query_results_p{f,j}` read + the
`@/types/deps` Smart imports. On `completed` **or** `payload_incompatible`:
`getRequiredSession()` → `loadCanonicalResult`. Canonical present →
`toConsultationView` → `<ConsultationResult>`; absent → `incompatibleView` →
`<ConsultationUnavailable>` (safe message + consultation ID). `queries` (status,
dates, name) and `ai_reports` reads stay on Supabase — carried to Tasks 9/11 per
scope guard.

### `src/app/(dashboard)/consultations/[id]/pdf/route.ts`
Rewritten: canonical-only. `getRequiredSession` → `loadCanonicalResult` →
`toConsultationView` → `renderFullConsultationPdf`. No canonical row → HTTP 409
with the consultation ID. Deleted the `raw_response` rich/plain branching and the
`renderConsultationPdf` wide-table fallback. `ai_reports` read kept (Supabase).

### `src/app/(dashboard)/batch/[id]/pdf/route.ts`
Per-member `loadCanonicalResult` → `toConsultationView` → `CompanyProcessEntry`.
`raw_response` read removed. `batches` / `company_reports` reads kept (Supabase).

### `src/lib/ai/prompt.ts`
New `buildCanonicalBureau(c)` — EXPLICIT canonical allow-list. Includes: subject
name/kind/registration/age/óbito/PEP/legalNature/CNAE/porte/capital(reais)/
start-date/city/uf, score (value/band/description/prob), pendências + ações
judiciais occurrences (credor/tipo/valor/data/cidade/uf), protests
(cartório/uf/data/valor), cheques counts, query-window counts, quadro societário
& participações (nome/participação/cargo). **Excluded:** every document number,
street addresses, phones, e-mail, `checks.note`, all `messages`,
`provider.consultationId`, mother's name, birth date, raw payload.
`ParecerInput` is now `{ type, dataAnalise, canonical }`. `PROMPT_VERSION`,
`OPENAI_MODEL`, all system prompts unchanged. `buildPjBureau` / `buildPfBureau` /
`buildCompanyPayload` / `CompanyParecerInput` left intact — the consolidated
company parecer (`actions/company.ts`) is a Tasks 9/11 Supabase path.

### `src/actions/ai.ts`
`generateOpinion` bureau-input path: `currentIdentity()` (new helper) →
`loadCanonicalResult` instead of the `query_results_p{f,j}` read; passes
`canonical` to `generateParecer`. `queries` / `ai_reports` / `timeline_events`
writes unchanged (carried).

### `src/components/consultations/consultation-result.tsx`
`ResultView` → `ConsultationView`. Added `ConsultationUnavailable`. Dropped the
Smart card and the Fatores-Smart list (not in the canonical contract).

## Verify

```
npx vitest run src/lib/consultations/view-model.test.ts   → 7 passed
npx vitest run (full)                                     → 116 passed | 19 skipped
   3 integration suites fail: connect ECONNREFUSED 127.0.0.1:54329 (no Docker
   Postgres — pre-existing, deferred to Task 15, unchanged from Tasks 6/7)
npm run type-check → only the 4 carried Task 7 errors (see concerns)
rg -n "raw_response|bureau_payloads.*payload|deps_response" src/app src/lib/pdf src/lib/ai src/actions/ai.ts → clean
rg -n "deps/protestos" src → clean (adapter.ts imports the relative "./protestos", see concern 2)
```

## Concerns

1. **Carried type-check paths (4, all from Task 7, all permitted by the scope
   guard — legacy `supabase.from("queries").update({ status: "payload_incompatible" })`
   on the stale generated enum):**
   - `src/actions/company.ts:255`
   - `src/actions/consultations.ts:292`
   - `src/actions/consultations.ts:408`
   - `src/actions/scr.ts:158`
   No new red introduced. `view-model.ts`, its test, `canonical-store.ts`, the PDF,
   both PDF routes, the detail page's canonical branch and `actions/ai.ts`'s
   canonical path all type-check clean.

2. **`src/lib/deps/protestos.ts` NOT deleted.** `rg -n "deps/protestos" src` is
   clean, but `src/lib/deps/adapter.ts` (Task 6) still imports it as `./protestos`
   (`summarizeProtestos`, used by `mapProtests`). Deleting the module would break
   the adapter, and the rulings explicitly forbid editing `adapter.ts`. All Task 8
   consumers (`page.tsx`, `pdf/route.ts`, `consultation-full-document.tsx`) no
   longer reference it. Recommend Task 9+ inline `summarizeProtestos` into
   `adapter.ts` then delete `protestos.ts` + `protestos.test.ts`.

3. **Canonical-shape flag (not a change — flagged per ruling):** `CanonicalChecks`
   has no per-motive breakdown — the old PDF showed "devolvidos sem fundo" and
   "outros motivos" separately; canonical only carries `returnedNoFunds` /
   `stopped` / a single `note`. The view-model renders what exists. No shape change
   requested; acceptable for the canonical render path.

4. **UI surface reduction (intended, mandated by "canonical only"):** the detail
   screen and PDF no longer show Smart classification/parecer, SCR detail, renda/
   faturamento presumida, secondary addresses, phones or e-mails — none are in
   `CanonicalBureauResult`. If any must return, it is a Task 6 canonical-shape
   change, not a Task 8 renderer change.

5. **Full runtime verification deferred to Task 15** (no historical Postgres data;
   `bureau_results` only populated by Task 7's new-consult flow). The canonical
   render + AI-input paths are code-complete and unit-tested now.
