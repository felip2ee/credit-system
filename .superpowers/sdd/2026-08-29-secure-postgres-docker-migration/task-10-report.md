# Task 10 report — Private Scanned Document Storage

## Status: DONE

## What shipped

| File | Purpose |
|---|---|
| `db/migrations/006_document_objects.sql` | NEW forward-only migration. Adds `object_key, sha256, byte_size, detected_mime, scan_result, scan_version` to `opportunity_documents`. 001–005 untouched. |
| `src/lib/documents/storage.ts` | Filesystem layer: `writeQuarantine` (streamed, per-chunk `inspect` callback, fsync, partial cleanup on throw), `readQuarantine`, `commitQuarantine` (atomic `rename` to `objects/<first-two>/<uuid>`), `removeQuarantine`, `openObject` (resolve + assert inside `objects/`). No absolute path leaves the module. |
| `src/lib/documents/clamav.ts` | `zINSTREAM` client with connect + scan timeouts. **Fails closed**: timeout / connection error / malformed reply → `ScannerUnavailableError`. Parses `stream: OK` vs `stream: <sig> FOUND`. `scannerVersion()` best-effort `zVERSION` (null on failure). Host/port/timeouts overridable via `ScanOptions` (used by tests). |
| `src/lib/documents/service.ts` | `storeDocument()`: traversal-name reject → stream to quarantine enforcing 15 MiB while hashing + capturing header → magic-byte detect (PDF `%PDF-`, JPEG `FF D8 FF`, PNG 8-byte) → extension + declared-MIME must agree with detected signature (rejects polyglot prefixes since magic must sit at offset 0) → ClamAV scan → clean: `scannerVersion` + atomic move + persist row in `withUserTransaction` + `writeAuditEvent` → infected/unavailable: delete quarantine + best-effort failure audit + throw `DocumentRejectedError`. `sanitizeDisplayName` for metadata only. `persist` injection seam so the accept path is testable without Postgres. |
| `src/lib/documents/service.test.ts` | Vitest: temp `DOCUMENT_ROOT` via `vi.hoisted` + `mkdtempSync`; fake ClamAV via `net.createServer`. 12 tests, all green. |
| `src/app/api/documents/[id]/route.ts` | `GET`: loads metadata row inside `withUserTransaction` (RLS → invisible row yields 404), opens object by stored key with traversal protection, streams via `handle.readableWebStream()` (no full-file buffer), sets `Content-Type` (stored MIME, safe-list only, else `octet-stream`), `Content-Disposition` (sanitized name), `X-Content-Type-Options: nosniff`. |
| `src/actions/portal.ts` | `uploadPortalDocument` now routes the binary through `storeDocument` (was Supabase Storage upload + metadata `.update`). `getPortalDocUrl` returns `/api/documents/<id>` (was Supabase signed URL). Ownership check + timeline mirror unchanged (timeline stays Supabase = carried Task 11 path). |
| `src/actions/opportunities.ts` | New `uploadOpportunityDocument(formData)` (staff, binary via `storeDocument` + timeline + `autoAdvanceFromDocs`). `getOpportunityDocUrl(docId)` returns `/api/documents/<id>`. `recordOpportunityDocUpload` kept but marked superseded (Task 11 removes it). |
| `src/components/opportunities/document-checklist.tsx` | Upload POSTs `FormData` to `uploadOpportunityDocument` instead of client-side Supabase Storage upload; download calls `getOpportunityDocUrl(doc.id)`. Removed `createClient`/`BUCKET`. (Portal checklist already uploaded through its server action — no change needed there.) |

## Verification

- `npx vitest run src/lib/documents/service.test.ts` → **12 passed**. Named fake-server results: `"fails closed on scanner timeout"` ✓, `"fails closed on scanner connection error"` ✓, `"rejects an infected result and deletes the quarantine file"` ✓, `"accepts a clean PDF: moves to objects/ and persists metadata"` ✓ (+ clean JPEG/PNG, oversize, ext/sig mismatch, declared-mime mismatch, polyglot prefix, traversal name, `openObject` traversal).
- `npx vitest run src/lib/deps src/lib/consultations` → 21 passed / 7 skipped; `service.integration.test.ts` fails with `ECONNREFUSED :54329` — **pre-existing**, needs real Postgres, already deferred to Task 15 (Task 3 gate ruling), not touched by this task.
- `npm run type-check` → only the 4 carried Task 7 errors (`payload_incompatible` in `actions/company.ts`, `actions/consultations.ts` ×2, `actions/scr.ts`). New documents code + rewired upload/download paths are type-clean.
- `node --test scripts/db/migrate.test.mjs` → 3 passed (checksum logic unaffected by 006).

## Concerns

- **Migration choice**: extra columns on `opportunity_documents` (not a new `document_blobs` table) — smaller change, and the table already grants `select/insert/update/delete` to `app_runtime` so no new grant/RLS needed. `crm_client_documents` is a CPF/CNPJ-string table, not file storage, so it is untouched.
- **Deferred DB assertions (Task 15)**: the metadata-persist transaction in `storeDocument` and the download-route RLS-404 behaviour need a live Postgres. Authored, not asserted here. The accept-path test verifies quarantine→objects move + `persist` invocation via the injection seam; the failure-path failure-audit is best-effort (swallows DB errors) to keep fail-closed behaviour testable without a DB.
- **Carried Supabase paths (Task 11)**: timeline-event inserts in both actions still use the Supabase service client; `recordOpportunityDocUpload` and `SignedUrlResult`-style Supabase calls elsewhere in these two files remain. Scope guard honoured — only the document upload/download binary paths were rewired.
- **Orphan objects**: if the persist transaction throws after `commitQuarantine`, the committed object file is left on disk (quarantine already renamed away). Cleanup is a Task 15 concern; noted with a comment.
- `handle.readableWebStream()` used in the route (Node ≥ 20); cast to `ReadableStream` for the Response type.

## Fix round 1

Addressed the 3 Important + 5 minor findings.

| # | Fix |
|---|---|
| IMPORTANT 1 | `route.ts`: replaced `handle.readableWebStream()` with `Readable.toWeb(handle.createReadStream())` and an explicit `handle.close()` on the node stream's `close` event (fires on end / error / client cancel). No leaked fd per download. |
| IMPORTANT 2 | Both wired upload paths (`portal.ts`, `opportunities.ts`) now pass `file.stream()` into `storeDocument` instead of `Buffer.from(await file.arrayBuffer())` — the 15 MiB cap is enforced chunk-by-chunk in `writeQuarantine`'s `inspect` callback before the whole body is in RAM. `clamav.ts`: `scanBuffer` → `scanStream(AsyncIterable)`, sends `zINSTREAM` in length-prefixed chunks. `service.ts` scans via `quarantineStream(id)` (a `createReadStream`), never `readQuarantine` (removed). `storage.ts`: added `quarantineStream`, dropped `readQuarantine`. |
| IMPORTANT 3 | (a) `storeDocument` tracks `committedKey`; on any post-commit failure it calls `removeObject(committedKey)` (traversal-guarded, added to `storage.ts`) so a failed persist no longer leaks a file in `objects/`. (b) `persistMetadata` now asserts `result.rowCount === 1` and throws otherwise — a wrong or RLS-invisible `docId` (0 rows) is a failure, not a phantom success. **Task 15 must exercise this `update ... where id = $1` + `rowCount` check against real Postgres with RLS active.** |
| MINOR 4 | Empty / `application/octet-stream` declared MIME now skips the MIME-vs-signature check (extension + magic bytes still gate). New test: `"accepts an empty / octet-stream declared MIME"`. |
| MINOR 5 | Traversal test second case switched from Windows-only `..\..\secret` to POSIX `aa/../../../escape`. |
| MINOR 6 | `afterEach` wipes both `quarantine/` and `objects/` for per-test isolation; every rejection test (oversize / mismatch / declared-mime / polyglot / timeout / conn-error / infected) now also asserts `objectFiles()` is empty. New test `"rolls back the committed object when persist fails"` covers IMPORTANT 3(a). |
| MINOR 7 | `auditFailure` bare `catch {}` → `console.error` with event reason only (no contents / paths). Fail-closed unchanged. |
| MINOR 8 | `sanitizeDisplayName` dropped the doubled control-char strip; keeps spaces/hyphens ("Meu RG.pdf" stays intact), still collapses path separators / control chars / non-safe chars to `_`. |

### Commands

```
$ npx vitest run src/lib/documents/service.test.ts
 Test Files  1 passed (1)
      Tests  14 passed (14)

$ npm run type-check
src/actions/company.ts(255,17): error TS2322: '"payload_incompatible"' ...
src/actions/consultations.ts(292,17): error TS2322: '"payload_incompatible"' ...
src/actions/consultations.ts(408,19): error TS2322: '"payload_incompatible"' ...
src/actions/scr.ts(158,17): error TS2322: '"payload_incompatible"' ...
```

Only the 4 pre-existing carried Task 7 errors remain; no new errors from documents code or the rewired paths.
