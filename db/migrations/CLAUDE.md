# migrations — forward-only numbered SQL schema, roles and RLS policies

Source of truth for the Postgres 18 schema. Security-sensitive: roles, grants and Row-Level Security are defined here.

## Responsibility

Holds `NNN_snake_case.sql` files (001–005, 008–023 today): roles, Better Auth tables, business tables, RLS, indexes, public SCR authorization, and the grant boundary for cross-tenant functions. It does NOT hold application queries (`src/lib/<domain>/queries.ts`) or the runner (`scripts/db/migrate.mjs`).

## Key patterns

- File name must match `^\d{3}_[a-z0-9_]+\.sql$` (enforced by `loadMigrations`); next number is 026.
- Policy: until the first production deploy the directory is an editable base. From the first production deploy (date: fill in at deploy) it is forward-only with checksum.
- Applied files are immutable: `schema_migrations` stores a sha256 checksum and the runner throws on a mismatch or a missing file. Fix by adding a new migration. A forward-only migration adds a new file and never edits an old one.
- `021_client_accounts.sql` holds the client self-registration gateway (`register_client`, verification and legal-acceptance functions) and the `protect_profile_contact` trigger.
- `022_orders_delivery.sql` holds the order (`dossier_orders` + `dossier_orders_guard`), `open_order`, `refresh_order_state`, `due_order_bureaus`, the per-Bureau system profile (`profiles.is_system`, hidden from `auth_profile_for_session`) and the client delivery policies (`*_client_released`).
- `023_lgpd_retention.sql` holds the LGPD retention: nullable `document` on `holders`, `consultations` and `bureau_results`, `anonymized_at` on `holders` and `profiles`, the `dossier_orders_guard` exception for `subject_name -> 'Titular anonimizado'`, the role `lgpd_owner` (NOLOGIN, NOBYPASSRLS; owns the LGPD functions and holds their column grants and `*_lgpd_*` policies), the trigger `holders_anonymized_guard` and the functions `lgpd_anonymize_holder`, `lgpd_anonymize_client_account`, `lgpd_purge_bureau(p_limit)`, `lgpd_purge_technical` and `lgpd_sweep_targets`.
- `025_client_order_ops.sql` holds the client order operations: `cancel_client_order`, `client_order_members` and `record_order_declaration` (definer functions owned by `auth_profile_lookup`, ownership checked in SQL), the table `order_declarations` (append-only, RLS), the `cancelled_by_client` reason, and the `buyer_declaration` legal kind (terms v2 and declaration v1 are provisional text).
- `001_roles.sql` defines `schema_owner`, `app_runtime` (NOBYPASSRLS), `backup_reader` (BYPASSRLS, read-only) and `auth_profile_lookup` (NOLOGIN, BYPASSRLS). `009` removes BYPASSRLS from `auth_profile_lookup` and sets NOINHERIT.
- `004_rls.sql` defines `app_user_id()`, `app_user_role()`, `app_bureau_id()`, `app_support_session_id()`, `app_context_present()`, `app_support_active()` and `app_is_staff()`. Each table gets `enable row level security` and `force row level security`, then named policies (e.g. `profiles_select`, `holders_staff`).
- `004_rls.sql` also defines `auth_profile_for_session` (returns `must_change_password`) and the `protect_profile_identity` trigger. The trigger allows only an operator-to-bureau_admin role change. It gates `must_change_password`: only the gateway or the user's own true-to-false update may change it.
- `009_public_scr_gateway_privileges.sql` sets the grant boundary for the cross-tenant definer functions.
- `admin_set_credentials(p_target_id, p_bureau_id, p_password_hash)` (009) checks the caller and target in SQL:
  - superadmin: targets only a `bureau_admin` of `p_bureau_id`;
  - bureau_admin: targets only an `operator` of its own Bureau;
  - never self, peer admin, superadmin or client.
  It sets the hash or only the flag, and deletes the target's sessions and pending reset tokens. It returns `false` on a non-match.
- `SECURITY DEFINER` functions set `search_path = pg_catalog, public`, change owner, `revoke all ... from public`, and `grant execute` to `app_runtime` only (e.g. `auth_profile_for_session` in 004, `public_scr_authorization` in 008, `admin_set_credentials` in 009).
- New indexes follow the `<table>_<columns>_idx` name (`005_indexes.sql`).

## Applied rules

Rules active in this directory — read them before touching code here:

- @.claude/rules/06-security.md — Least privilege and cross-tenant protection. Here: every table needs forced RLS, minimal grants, and a role check in each policy.
- @.claude/rules/ecc/common/security.md — No hardcoded secrets. Here: roles are created without passwords; credentials come from deployment env.
- @.claude/rules/05-testing.md — Security and data isolation must have tests. Here: a new policy or definer function needs a case in `src/lib/db/rls.integration.test.ts`.

## Local conventions

- Never edit an applied migration; add the next number. Never reintroduce Supabase.
- Each file runs in one transaction (the runner wraps it in begin/commit): do not add your own `begin`/`commit`, and avoid statements that cannot run inside a transaction.
- Make role creation idempotent with a `do $$ ... if not exists (select 1 from pg_roles ...)` block.
- Start a file with a comment that states intent when the migration is non-obvious (008, 009).

## Rules
<!-- aia-harness:fixed — non-negotiable; do not edit, reorder, or remove during enrichment -->

- Follow the root `CLAUDE.md` canonical commands.
- Keep modules focused; prefer small, well-named units over large files.

<!-- Generated by aia-harness revise-claude-md. Re-run /aia-harness:revise-claude-md to update. -->
