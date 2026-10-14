# auth — Better Auth config, session guard and authorization helpers

Authentication layer on Better Auth 1.7 (email + password, mandatory TOTP MFA for staff). Security-sensitive: any change needs `security-reviewer`.

## Responsibility

Holds the Better Auth options (`config.ts`), the server instance and HTTP handler wrapper (`server.ts`), the browser client (`client.ts`, `"use client"`), session enforcement (`session.ts`), profile and role helpers (`authorization.ts`), temporary credentials (`credentials.ts`), user invites (`invite.ts`), password rules (`src/lib/validators/password.ts`), reset-password mail (`email.ts`) and the redirect guard (`callback.ts`). It does NOT hold the permission catalog or the pool (`src/lib/db/`), the edge cookie check (`src/middleware.ts`), or login/MFA/change-password pages (`src/app/(auth)/`).

## Key patterns

- `getRequiredSession()` / `getRequiredSessionFromHeaders(headers, now)` returns `RequiredSession` or throws `SessionAccessError` with a code (`session_required`, `session_idle_expired`, `session_absolute_expired`, `mfa_setup_required`, `password_change_required`, `user_deactivated`, `bureau_inactive`). `now` is injectable for tests.
- Check order: login, then MFA (`mfa_setup_required`, staff only), then the forced password change (`password_change_required`).
- `sessionErrorPath(error)` in `session.ts` maps `mfa_setup_required` to `/mfa/setup`, `password_change_required` to `/change-password`, and every other error to `/login`. Layouts redirect with it.
- Session limits are constants in `session.ts`: absolute 24 h, idle 30 min, activity write every 5 min. Expired or deactivated users get `revokeUserSessions`; `mfa_setup_required` and `password_change_required` keep the session on purpose.
- `profiles.must_change_password` is the forced-change flag. `auth_profile_for_session` returns it. Only `admin_set_credentials` (migration 009) sets it. Only the password flows clear it.
- Only code that never calls `getRequiredSession` skips the flag: `signOut`, `/api/auth/*`, `/api/health/*`. `sendScrSelfAuthorization` calls it, so it is denied too.
- Role, Bureau and support state come from `profiles` through the SQL function `auth_profile_for_session` (`findAuthProfile`), never from the Better Auth user record.
- A user of an inactive Bureau gets `bureau_inactive`. A superadmin is not blocked by Bureau status.
- Team mutations (`src/actions/users.ts`) run in `withUserTransaction` and delete the target's sessions in the same transaction.
- `authConfig` uses `satisfies BetterAuthOptions`, maps camelCase fields to snake_case columns, `disableSignUp: true`, `minPasswordLength: 12`, DB-backed rate limit, `__Host-` cookie prefix in production.
- `authHandler` rejects `trustDevice` on 2FA verify paths. It forces `revokeOtherSessions: true` on `/change-password`. It rejects a `newPassword` equal to `currentPassword` with `PASSWORD_UNCHANGED` (400).
- Route `/change-password` (`src/app/(auth)/change-password/`) calls Better Auth `authClient.changePassword`. Its layout sends a user without the flag to `/`.
- The `hooks.after` branch for `/change-password` clears the flag after success. It never throws: a failure logs and keeps the new session. If the flag stays set, the layout returns the user to `/change-password`.
- The `hooks.after` branch for `/two-factor/verify-totp` deletes the user's other sessions after enrollment. It reads `ctx.context.session` and `ctx.context.newSession`, which are Better Auth internals. Re-check it after a Better Auth upgrade.
- `onPasswordReset` clears the flag through `clearMustChangePassword`. Unlike the change-password branch, this call can throw.
- `setTemporaryCredentials` (`credentials.ts`) calls the gateway. A null password only sets the flag. The password is hashed and never written to SQL or audit.
- `createInvite` (`invite.ts`) creates a user with a password and the flag in the caller's transaction. No e-mail is sent.
- Password rules: 12 to 128 characters. Use `firstPasswordError` in imperative forms and `refineOptionalNewPassword` in zod. A blank optional password means no password.

## Applied rules

Rules active in this directory — read them before touching code here:

- @.claude/rules/06-security.md — Authentication and backend authorization, least privilege, no secrets or tokens in logs. Here: session, MFA and revocation logic is the main security boundary.
- @.claude/rules/ecc/common/security.md — Rate limiting, CSRF, secrets from env. Here: `config.betterAuthSecret` only; keep rate limit and cookie flags enabled.
- @.claude/rules/05-testing.md — Test auth and security branches with happy and edge cases. Here: each `SessionAccessError` code and each handler rewrite needs a case (`server.test.ts`, `session.test.ts`, `auth.integration.test.ts`).
- @.claude/rules/typescript/coding-standards.md — Narrow types with guards, not `as`. Here: `isAppRole` narrows the DB role string.
- @.claude/rules/01-ddd.md — Keep framework details at the edge. Here: Better Auth stays in this directory; callers see `RequiredSession` only.

## Local conventions

- Do not disable security options (`disableSignUp`, rate limit, secure cookies, `disableSessionRefresh`) to fix an error.
- Add a new session failure as a new `SessionAccessError` code and handle it in the callers; do not return `null`.
- Any role or active-state change must revoke sessions in the same transaction.
- Clear `must_change_password` only in `clearMustChangePassword` or the gateway.
- Credential events use `user.password_set`, `user.force_password_change`, `user.create_with_password` and `user.password_changed`. Never store the password.
- Use the injected `now` parameter in tests instead of fake timers on the real clock.

## Rules
<!-- aia-harness:fixed — non-negotiable; do not edit, reorder, or remove during enrichment -->

- Follow the root `CLAUDE.md` canonical commands.
- Keep modules focused; prefer small, well-named units over large files.

<!-- Generated by aia-harness revise-claude-md. Re-run /aia-harness:revise-claude-md to update. -->
