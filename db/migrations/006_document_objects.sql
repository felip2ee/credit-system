-- Private scanned document storage (Task 10).
--
-- Files no longer live in Supabase Storage. The binary is streamed to
-- DOCUMENT_ROOT/quarantine, virus-scanned via ClamAV INSTREAM, and on a clean
-- result moved to DOCUMENT_ROOT/objects/<first-two>/<uuid>. Only the *relative*
-- object key is persisted here -- never an absolute host path.
--
-- Forward-only, checksum-tracked. opportunity_documents already grants
-- select/insert/update/delete to app_runtime, so new columns need no new grant.

alter table opportunity_documents
  add column object_key text,
  add column sha256 text,
  add column byte_size bigint,
  add column detected_mime text,
  add column scan_result text,
  add column scan_version text;
