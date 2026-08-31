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
