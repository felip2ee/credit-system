# PostgreSQL Docker Security Design

**Status:** Approved in chat on 2026-08-29  
**System:** Reino do Crédito  
**Scope:** Replace Supabase database, authentication, authorization, MFA, and storage while preserving business data and documents.

## Goal

Run the credit system on one Docker Swarm server with a private PostgreSQL database, application-owned authentication, private document storage, encrypted off-site backups, and a stable boundary around changing DEPS payloads.

The migration must preserve business records, identifiers, relationships, timestamps, reports, audit history, raw bureau responses, users, and uploaded documents. Existing passwords, sessions, reset tokens, and MFA secrets will not be reused.

## Current Problem

The current database is already PostgreSQL through Supabase. Moving it to another PostgreSQL instance alone does not solve consultation failures.

DEPS responses are cast into TypeScript types without runtime validation. Multiple consumers interpret the same response differently, and the response is flattened into wide PF/PJ tables. When DEPS changes nesting, field names, nullability, or object shape, mapping or persistence can fail. Some write paths ignore the database error and still mark the consultation as completed.

Supabase is also an application platform dependency, not only a database dependency. The system currently relies on Supabase Auth, MFA, admin user APIs, cookies, RLS helpers, service-role writes, Storage, signed URLs, and storage policies.

## Approved Constraints

- Deployment remains on one Docker Swarm server behind the existing Traefik instance.
- A maintenance window with downtime is acceptable for final cutover.
- All business data, users, and documents must be preserved.
- Staff authentication uses email and password with mandatory TOTP.
- Client TOTP is optional.
- Encrypted off-site backup to an external S3-compatible bucket is allowed.
- Maximum acceptable data loss after total server loss is 24 hours.
- Security takes precedence over minimizing components or implementation effort.
- No automatic data expiration is introduced until a legal retention policy is approved.

## Architecture

```text
Internet
   |
   | HTTPS
Traefik
   |
Next.js application
   |-- Better Auth ---------- PostgreSQL
   |-- business data -------- PostgreSQL
   |-- uploads -------------- private document volume
   |-- malware scan --------- ClamAV
   |-- outbound ------------ DEPS / OpenAI / SMTP

Backup job
   |-- PostgreSQL pg_dump
   |-- private document volume
   `-- Restic encryption ---- external S3 bucket
```

Only Traefik publishes an external port. PostgreSQL and ClamAV are reachable only on an internal Docker network. The document volume is mounted only into the application and backup jobs.

The active stack contains the application, PostgreSQL, ClamAV, and a backup job. Redis, MinIO, an ORM, and separate business microservices are excluded because the approved requirements do not need them.

The replacement targets infrastructure and unsafe integration boundaries. Existing screens and proven business rules may be retained after their data access is migrated and tested.

## Runtime and Database Roles

PostgreSQL uses separate credentials and grants:

- `schema_owner`: owns schemas and objects; used only by the migration job.
- `app_runtime`: runs the application; no DDL, ownership, superuser, or `BYPASSRLS` privileges.
- `backup_reader`: used only by the backup job; has `CONNECT`, schema `USAGE`, table `SELECT`, and `BYPASSRLS` because a complete dump must include every protected row. It has no write or DDL privileges, and its secret is mounted only in the backup job.

The application container runs as a non-root user with a read-only root filesystem. Its only writable locations are the private document volume and an explicitly bounded temporary directory.

All production credentials are Docker Secrets. Secrets are not passed as build arguments, stored in the repository, emitted in logs, or exposed with `NEXT_PUBLIC_*` variables.

## Authentication

Better Auth is the application authentication provider and connects directly to PostgreSQL through the existing `pg` driver.

Required configuration:

- Public sign-up disabled; administrators invite users.
- Email and password authentication enabled.
- Password minimum length of 12 and maximum length of 128.
- Default `scrypt` password hashing retained.
- Database-backed sessions and database-backed rate limiting.
- Session cookies use a `__Host-` prefix and are `HttpOnly`, `Secure`, and `SameSite=Lax`.
- Sessions expire after 24 hours absolutely. A 30-minute inactivity limit is enforced server-side on every protected request; the browser timer provides only the immediate logout experience.
- Trusted origins contain only the production application origin.
- Proxy trust contains only the Traefik network/proxy addresses.
- Password reset links are single-use and expire after 15 minutes.
- Password change, user deactivation, role change, and credential recovery revoke all existing sessions.
- Repeated password or second-factor failures cause rate limiting and temporary account lockout.

TOTP is mandatory for `admin` and `consultant`. Enrollment must complete before a staff user can access the dashboard. Staff cannot bypass TOTP by trusting a device. Recovery codes are generated during enrollment and displayed only in a fresh authenticated flow. TOTP remains optional for `client` users.

Migration preserves each user's identifier, name, normalized email, role, and active state. Better Auth stores the existing Supabase UUID string as its user identifier; `profiles.id` remains the same PostgreSQL UUID and also stores a foreign-keyed text `auth_user_id`. New authentication identifiers use the same UUID-string format. Supabase password hashes, sessions, refresh tokens, reset tokens, recovery codes, and MFA secrets are not imported. Every migrated user must set a new password; staff must enroll a new TOTP secret.

## Authorization and Row Security

Application authorization is deny-by-default. A centralized permission matrix defines allowed operations for `admin`, `consultant`, and `client`. Every Server Action and Route Handler verifies a permission, not merely the presence of a session.

Business queries execute through a transaction helper that sets transaction-local context with parameterized `set_config` calls:

- `app.user_id`
- `app.user_role`

Because the values are transaction-local, pooled connections cannot leak identity between requests.

PostgreSQL RLS provides defense in depth for portal-visible tables. Policies read the transaction-local identity and role. The runtime role is not a table owner and cannot bypass RLS. Tables with RLS use default denial when no policy matches.

Clients may access only their own CRM identity, opportunities, clean opportunity documents, and permitted timeline events. Clients cannot read bureau payloads, bureau results, internal AI reports, audit logs, settings, or other clients' records. Staff access remains subject to the application permission matrix and database grants.

## Active Business Data

The new schema retains active domains:

- user profiles and roles;
- CRM clients, documents, and relationships;
- consultations and SCR authorizations;
- bureau payloads and canonical bureau results;
- company batches and consolidated reports;
- AI reports;
- credit products and opportunities;
- opportunity documents;
- timeline events and notes;
- settings and audit events.

Legacy tables with no application consumer, including the original `clients`, `authorizations`, and `notifications` tables, are not part of the active schema. Their original data remains in the encrypted source dump. Removing or destroying the source is a separate, explicitly authorized operation.

Existing UUIDs and foreign-key relationships are retained. Business foreign keys are never regenerated.

## Bureau Payload Boundary

The wide `query_results_pf` and `query_results_pj` payload projections are replaced by two responsibilities:

### `bureau_payloads`

Append-only record of the provider response:

- consultation identifier;
- provider and product;
- received timestamp and HTTP status;
- raw response body as `JSONB`;
- SHA-256 hash of the canonical serialized body;
- adapter status and validation errors without sensitive values.

Raw payloads are immutable. Application roles cannot update or delete them.

### `bureau_results`

One validated canonical result per completed consultation:

- consultation identifier and PF/PJ kind;
- adapter version;
- canonical normalized result as `JSONB`;
- small searchable projections: document, display name, score value, and risk band;
- normalization timestamp.

Only fields proven necessary for filtering or indexing become scalar columns. All display, PDF, and AI consumers use the canonical result type. They never read provider-specific raw JSON.

## DEPS Processing Flow

1. Create or update the consultation as `processing`.
2. Call DEPS outside a database transaction.
3. Store the received payload before normalization.
4. Select a versioned Zod adapter based on recognized response shape.
5. Preserve unknown additive fields while validating required identity and known modules.
6. In one database transaction, write the canonical result and mark the consultation `completed`.
7. If the response is incompatible, preserve it and mark the consultation `payload_incompatible` with a safe diagnostic code.
8. If persistence fails, roll back the result and status change together.

There is one provider adapter boundary. `as unknown as` casts cannot be used to trust external data. Additive fields do not fail validation. Removed, renamed, or invalid required identity fields fail closed without producing a blank completed consultation.

The adapter supports documented historical variants, such as a score value named `valor` or `score`, wrapped and unwrapped `smart` modules, and legacy/current protest structures. Each supported variant is represented by an anonymized fixture.

## Documents and Malware Handling

Documents are stored outside the public application tree in a private Docker volume. Database records contain metadata and a random storage identifier, not a user-controlled path.

Upload rules:

- allow only PDF, JPEG, and PNG;
- enforce a 15 MiB maximum size before buffering the full upload;
- verify magic bytes instead of trusting extension or browser MIME;
- generate the storage name server-side;
- reject path traversal and control characters;
- initially mark the file as quarantined;
- scan with ClamAV;
- fail closed if scanning is unavailable, times out, or reports malware;
- make only `clean` files downloadable.

Downloads re-check session, permission, ownership, and clean scan status. Responses use `Content-Disposition: attachment`, a safe filename, `X-Content-Type-Options: nosniff`, and no public caching.

## Network and HTTP Security

- PostgreSQL and ClamAV have no published host ports.
- Traefik terminates TLS and redirects HTTP to HTTPS.
- HSTS is enabled only after the production domain is confirmed HTTPS-only.
- The application sets a restrictive CSP, frame denial, referrer policy, permissions policy, and MIME sniffing protection.
- CORS is not enabled because the browser application and authentication endpoint are same-origin.
- Authentication rate limiting uses the database so application restarts cannot clear counters.
- Health endpoints expose readiness only, never configuration or sensitive dependency details.

## Logging and Audit

Operational logs are structured and correlate requests with opaque technical IDs. They cannot contain passwords, session tokens, authorization headers, reset links, MFA material, full CPF/CNPJ values, full provider responses, or document contents.

The append-only audit stream records:

- successful and failed authentication events;
- MFA enrollment, recovery, and failure events;
- user creation, deactivation, and role changes;
- bureau consultation state changes;
- administrative settings changes;
- document upload, scan result, download, review, and deletion;
- permission-sensitive exports and report generation.

Audit entries record actor, action, target type and ID, timestamp, outcome, and safe metadata. The application runtime may insert but not update or delete audit entries.

## Migration and Cutover

Migration is scripted, repeatable, and tested against a production copy before downtime.

1. Export the Supabase business schemas in `pg_dump` custom format.
2. Export user identity metadata without reusable credentials or sessions.
3. Enumerate every Storage object and record its path, size, and SHA-256 hash.
4. Record source counts and integrity totals per active table.
5. Create an empty target database from versioned migrations.
6. Import active business data while preserving identifiers and timestamps.
7. Copy documents into the private volume and verify every hash.
8. Convert historical raw responses into canonical results using the same production adapters.
9. Record incompatible historical payloads without discarding them.
10. Verify row counts, foreign keys, status totals, payload hashes, document hashes, and representative user flows.
11. Repeat the rehearsal until the complete process passes without manual database edits.

Final cutover:

1. Put the old application into maintenance mode.
2. Take a final export and file inventory.
3. Recreate and import the target from the tested scripts.
4. Run all integrity gates.
5. Switch Traefik to the new application.
6. Run smoke tests for authentication, CRM, consultation, PDF, AI, portal, and documents.
7. Send password setup instructions to migrated users.

If any integrity or smoke gate fails, Traefik returns to the old application while the old data remains unchanged. The Supabase source and encrypted exports are not destroyed automatically after success.

## Backup and Recovery

The accepted recovery-point objective is 24 hours.

Every day the backup job creates:

- a PostgreSQL custom-format dump;
- a snapshot of the private document volume;
- a manifest containing database, file, application, and migration versions.

Restic encrypts the backup client-side and uploads it to a versioned S3-compatible bucket. Retention is 14 daily, 8 weekly, and 12 monthly snapshots. Server credentials cannot permanently delete prior bucket versions.

A monthly restore drill creates an isolated database and document directory, restores the latest snapshot, runs integrity checks, and records duration and result. Backup, verification, or restore failure sends an email alert.

## Verification Gates

Implementation and migration are incomplete until all relevant gates pass:

- unit tests for every DEPS adapter fixture;
- additive, missing, renamed, null, and wrong-type payload cases;
- transaction rollback on persistence failure;
- no consultation marked complete without a canonical result;
- permission-matrix tests for all roles;
- cross-client denial tests in application and RLS layers;
- authentication, TOTP, lockout, reset, session revocation, and cookie tests;
- upload size, MIME spoofing, path traversal, scanner failure, malware, and download authorization tests;
- migration rehearsal with matching active row counts and no orphan foreign keys;
- matching hashes for all migrated documents and raw payloads;
- successful backup restoration;
- no Supabase package import, environment variable, network call, migration dependency, or runtime configuration remaining;
- PostgreSQL and ClamAV confirmed unreachable from the public network;
- rollback rehearsal completed before final cutover.

## Operations

- Container images are pinned to explicit versions, never `latest`.
- Application, PostgreSQL, ClamAV, and backup jobs have bounded resources and healthchecks.
- Updates are tested against a restored copy before production deployment.
- Backup and security failures alert through the configured SMTP service.
- Data deletion is an explicit audited administrative operation.
- No automatic retention purge is enabled until the responsible legal policy defines its rules.

## Non-Goals

- Multi-server high availability.
- Zero-downtime migration.
- Public object storage or direct document URLs.
- Redis, MinIO, an ORM, or business microservices.
- Reusing Supabase password hashes, sessions, or MFA secrets.
- Redesigning stable user interfaces without a security or migration requirement.

## External References

- Better Auth PostgreSQL adapter: <https://better-auth.com/docs/adapters/postgresql>
- Better Auth security: <https://better-auth.com/docs/reference/security>
- Better Auth two-factor authentication: <https://better-auth.com/docs/plugins/2fa>
- PostgreSQL row security: <https://www.postgresql.org/docs/18/ddl-rowsecurity.html>
- PostgreSQL backup and restore: <https://www.postgresql.org/docs/18/backup.html>
- PostgreSQL `pg_dump`: <https://www.postgresql.org/docs/18/app-pgdump.html>
- Restic S3 repository setup: <https://github.com/restic/restic/blob/master/doc/030_preparing_a_new_repo.rst>
