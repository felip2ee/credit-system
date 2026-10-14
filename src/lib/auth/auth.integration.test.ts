import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const resetEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearFlag = vi.hoisted(() => ({ fail: false }));

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
	});
});

vi.mock("./email", () => ({ sendPasswordResetEmail: resetEmail }));
// Real implementation, except when a test forces the after-hook clear to fail.
vi.mock("./credentials", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./credentials")>();
	return {
		...actual,
		clearMustChangePassword: async (authUserId: string) => {
			if (clearFlag.fail) throw new Error("forced failure");
			return actual.clearMustChangePassword(authUserId);
		},
	};
});

import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

import { setTemporaryCredentials } from "./credentials";
import { createInvite } from "./invite";
import { authHandler } from "./server";
import { getRequiredSessionFromHeaders, SessionAccessError } from "./session";

const password = "twelve-character-password";
const resetPassword = "another-twelve-character-password";

type TestUser = { id: string; email: string };

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

async function authRequest(
	path: string,
	body: Record<string, unknown>,
	headers?: HeadersInit,
) {
	// Every request shares one IP; clear the limiter so it does not hide what the test checks.
	await pool.query("delete from rate_limit");
	const requestHeaders = new Headers(headers);
	requestHeaders.set("content-type", "application/json");
	return authHandler(
		new Request(`http://localhost:3000/api/auth${path}`, {
			method: "POST",
			headers: requestHeaders,
			body: JSON.stringify(body),
		}),
	);
}

function sessionHeaders(response: Response): Headers {
	const cookie = response.headers.get("set-cookie");
	if (!cookie) throw new Error("expected Better Auth to set a session cookie");
	return new Headers({ cookie: cookie.split(";", 1)[0] });
}

// Seeded users have no credential account: give them one. Password sign-in only issues a
// session while MFA is off, so use loginWithMfa to enrol after signing in.
async function enable(userId: string): Promise<TestUser> {
	const email = `${userId}@example.test`;
	await owner.query(
		"insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, $3, now())",
		[randomUUID(), userId, await hashPassword(password)],
	);
	return { id: userId, email };
}

async function loginWithMfa(user: TestUser): Promise<Headers> {
	const headers = await login(user);
	await owner.query(
		'update "user" set two_factor_enabled = true where id = $1',
		[user.id],
	);
	return headers;
}

async function freshTenant(): Promise<SeededTenant> {
	return seedTenant(owner, "auth");
}

async function clientUser(): Promise<TestUser> {
	return enable((await freshTenant()).client.userId);
}

async function login(user: TestUser, userPassword = password) {
	const response = await authRequest("/sign-in/email", {
		email: user.email,
		password: userPassword,
	});
	expect(response.status).toBe(200);
	return sessionHeaders(response);
}

describe("Better Auth transport guard", () => {
	it("rejects trusted-device MFA requests", async () => {
		const response = await authRequest("/two-factor/verify-totp", {
			code: "123456",
			trustDevice: true,
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			code: "TRUST_DEVICE_DISABLED",
		});
	});
});

describe.sequential("Better Auth PostgreSQL integration", () => {
	beforeAll(async () => {
		await pool.query("select 1");
	});

	afterAll(async () => {
		try {
			await owner.end();
		} finally {
			await pool.end();
		}
	});

	it("rejects public email/password signup", async () => {
		const response = await authRequest("/sign-up/email", {
			name: "Public signup",
			email: "public-signup@example.test",
			password,
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
		});
	});

	it("blocks a fourth sign-in within ten seconds with a sane X-Retry-After", async () => {
		// Better Auth default for /sign-in: 3 requests per 10 s. authRequest clears the limiter, so send raw requests.
		await pool.query("delete from rate_limit");
		const signIn = () =>
			authHandler(
				new Request("http://localhost:3000/api/auth/sign-in/email", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ email: "nobody@example.test", password }),
				}),
			);
		try {
			const statuses: number[] = [];
			let blocked: Response | undefined;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const response = await signIn();
				statuses.push(response.status);
				blocked = response;
			}

			expect(statuses[3]).toBe(429);
			const { rowCount } = await pool.query(
				"select 1 from rate_limit where key like '%/sign-in/email'",
			);
			expect(rowCount).toBeGreaterThan(0);
			const retryAfter = Number(blocked?.headers.get("x-retry-after"));
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThan(3600);
		} finally {
			await pool.query(
				"delete from rate_limit where key like '%/sign-in/email'",
			);
		}
	});

	it("creates a database session when a preserved UUID user signs in", async () => {
		const user = await clientUser();
		const headers = await login(user);
		const { rows } = await pool.query<{ userId: string }>(
			'select user_id as "userId" from "session" where user_id = $1',
			[user.id],
		);

		expect(rows).toEqual([{ userId: user.id }]);
		await expect(getRequiredSessionFromHeaders(headers)).resolves.toMatchObject(
			{
				userId: user.id,
				role: "client",
				supportSessionId: null,
				support: null,
				permissions: [
					"portal:read",
					"portal:write",
					"credits:read",
					"credits:topup",
				],
				mfaComplete: false,
				email: user.email,
			},
		);
	});

	it("revokes an idle session after thirty minutes and writes activity no more than once per five minutes", async () => {
		const user = await clientUser();
		const headers = await login(user);
		await pool.query(
			"update \"session\" set updated_at = now() - interval '31 minutes' where user_id = $1",
			[user.id],
		);

		await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
			code: "session_idle_expired",
		} satisfies Partial<SessionAccessError>);
		await expect(
			pool.query('select 1 from "session" where user_id = $1', [user.id]),
		).resolves.toMatchObject({ rows: [] });

		const activeHeaders = await login(user);
		await pool.query(
			"update \"session\" set updated_at = now() - interval '6 minutes' where user_id = $1",
			[user.id],
		);
		await getRequiredSessionFromHeaders(activeHeaders);
		const first = await pool.query<{ updatedAt: Date }>(
			'select updated_at as "updatedAt" from "session" where user_id = $1',
			[user.id],
		);
		await getRequiredSessionFromHeaders(activeHeaders);
		const second = await pool.query<{ updatedAt: Date }>(
			'select updated_at as "updatedAt" from "session" where user_id = $1',
			[user.id],
		);

		expect(second.rows[0].updatedAt.getTime()).toBe(
			first.rows[0].updatedAt.getTime(),
		);
	});

	it("revokes a session older than twenty-four hours even when its database expiry is later", async () => {
		const user = await clientUser();
		const headers = await login(user);
		await pool.query(
			"update \"session\" set created_at = now() - interval '25 hours', expires_at = now() + interval '1 hour' where user_id = $1",
			[user.id],
		);

		await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
			code: "session_absolute_expired",
		} satisfies Partial<SessionAccessError>);
		await expect(
			pool.query('select 1 from "session" where user_id = $1', [user.id]),
		).resolves.toMatchObject({ rows: [] });
	});

	it("issues single-use password reset links that expire after fifteen minutes", async () => {
		const user = await clientUser();
		const sessionBeforeRecovery = await login(user);
		const response = await authRequest("/request-password-reset", {
			email: user.email,
			redirectTo: "http://localhost:3000/auth/reset-password",
		});
		expect(response.status).toBe(200);

		const { rows } = await pool.query<{ identifier: string; expiresAt: Date }>(
			"select identifier, expires_at as \"expiresAt\" from verification where value = $1 and identifier like 'reset-password:%'",
			[user.id],
		);
		const token = rows[0].identifier.replace("reset-password:", "");

		expect(rows[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(
			14 * 60_000,
		);
		expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
			15 * 60_000,
		);

		await expect(
			authRequest("/reset-password", { token, newPassword: resetPassword }),
		).resolves.toMatchObject({ status: 200 });
		await expect(
			getRequiredSessionFromHeaders(sessionBeforeRecovery),
		).rejects.toMatchObject({
			code: "session_required",
		} satisfies Partial<SessionAccessError>);
		await expect(
			authRequest("/reset-password", { token, newPassword: resetPassword }),
		).resolves.toMatchObject({ status: 400 });
	});

	it("revokes every session when a password is changed", async () => {
		const user = await clientUser();
		const passwordChangeHeaders = await login(user);
		const otherSessionHeaders = await login(user);

		const response = await authRequest(
			"/change-password",
			{ currentPassword: password, newPassword: resetPassword },
			passwordChangeHeaders,
		);

		expect(response.status).toBe(200);
		await expect(
			getRequiredSessionFromHeaders(otherSessionHeaders),
		).rejects.toMatchObject({
			code: "session_required",
		} satisfies Partial<SessionAccessError>);
	});

	it.each(["superadmin", "bureau_admin", "operator"] as const)(
		"returns mfa_setup_required for %s without MFA but keeps the session so staff can enrol",
		async (role) => {
			const tenant = await freshTenant();
			const userId =
				role === "superadmin"
					? (await seedSuperadmin(owner)).userId
					: tenant[role === "bureau_admin" ? "bureauAdmin" : "operator"].userId;
			const user = await enable(userId);
			const headers = await login(user);

			await expect(
				getRequiredSessionFromHeaders(headers),
			).rejects.toMatchObject({
				code: "mfa_setup_required",
			} satisfies Partial<SessionAccessError>);
			await expect(
				pool.query('select 1 from "session" where user_id = $1', [user.id]),
			).resolves.toMatchObject({ rows: [{ "?column?": 1 }] });
		},
	);

	it("loads the bureau of an operator of an active bureau", async () => {
		const tenant = await freshTenant();
		const user = await enable(tenant.operator.userId);

		await expect(
			getRequiredSessionFromHeaders(await loginWithMfa(user)),
		).resolves.toMatchObject({
			userId: user.id,
			role: "operator",
			bureauId: tenant.bureau.id,
			supportSessionId: null,
			support: null,
			mfaComplete: true,
		});
	});

	it("rejects an inactive bureau with bureau_inactive and revokes the sessions", async () => {
		const tenant = await freshTenant();
		const user = await enable(tenant.operator.userId);
		const headers = await login(user);
		await owner.query("update bureaus set status = 'inactive' where id = $1", [
			tenant.bureau.id,
		]);

		await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
			code: "bureau_inactive",
		} satisfies Partial<SessionAccessError>);
		await expect(
			pool.query('select 1 from "session" where user_id = $1', [user.id]),
		).resolves.toMatchObject({ rows: [] });
	});

	it("gives an active support session to a superadmin, even for an inactive bureau", async () => {
		const tenant = await freshTenant();
		await owner.query("update bureaus set status = 'inactive' where id = $1", [
			tenant.bureau.id,
		]);
		const superadmin = await seedSuperadmin(owner);
		const supportSessionId = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: tenant.bureau.id,
		});
		const user = await enable(superadmin.userId);

		const session = await getRequiredSessionFromHeaders(
			await loginWithMfa(user),
		);

		expect(session).toMatchObject({
			role: "superadmin",
			bureauId: tenant.bureau.id,
			supportSessionId,
			support: { bureauId: tenant.bureau.id },
		});
		expect(session.permissions).toContain("holders:read");
	});

	it("superadmin without support has no bureau", async () => {
		const superadmin = await seedSuperadmin(owner);
		const user = await enable(superadmin.userId);

		const session = await getRequiredSessionFromHeaders(
			await loginWithMfa(user),
		);

		expect(session).toMatchObject({
			bureauId: null,
			supportSessionId: null,
			support: null,
		});
		expect(session.permissions).not.toContain("holders:read");
	});

	it("expired support is not loaded", async () => {
		const tenant = await freshTenant();
		const superadmin = await seedSuperadmin(owner);
		await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: tenant.bureau.id,
			startedAt: new Date(Date.now() - 2 * 3_600_000),
			expiresAt: new Date(Date.now() - 3_600_000),
		});
		const user = await enable(superadmin.userId);

		await expect(
			getRequiredSessionFromHeaders(await loginWithMfa(user)),
		).resolves.toMatchObject({
			bureauId: null,
			supportSessionId: null,
			support: null,
		});
	});

	describe("temporary passwords and forced change", () => {
		const temporary = "temporary-password-12";
		const chosen = "chosen-password-by-owner";

		it("create with password then sign in", async () => {
			const tenant = await freshTenant();
			const email = `new-${randomUUID()}@example.test`;
			const outcome = await withUserTransaction(tenant.bureauAdmin, (client) =>
				createInvite(client, tenant.bureauAdmin.userId, {
					email,
					fullName: "Novo Operador",
					role: "operator",
					bureauId: tenant.bureau.id,
					password: temporary,
				}),
			);
			expect(outcome).toMatchObject({ ok: true, resent: false });
			if (!outcome.ok) throw new Error("setup");

			const headers = await login({ id: outcome.userId, email }, temporary);

			expect(await mustChange(outcome.userId)).toBe(true);
			await expect(
				getRequiredSessionFromHeaders(headers),
			).rejects.toMatchObject({
				code: "mfa_setup_required",
			} satisfies Partial<SessionAccessError>);
		});

		it("flagged user with MFA gets password_change_required", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);

			await expect(
				getRequiredSessionFromHeaders(await loginWithMfa(user)),
			).rejects.toMatchObject({
				code: "password_change_required",
			} satisfies Partial<SessionAccessError>);
			expect(await sessionCount(user.id)).toBe(1);
		});

		it("temporary password fails after the change; other sessions revoked", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);
			const first = await login(user);
			const second = await login(user);

			const response = await authRequest(
				"/change-password",
				{ currentPassword: password, newPassword: chosen },
				first,
			);

			expect(response.status).toBe(200);
			expect(await mustChange(user.id)).toBe(false);
			expect(await sessionCount(user.id)).toBe(1);
			await expect(getRequiredSessionFromHeaders(second)).rejects.toMatchObject(
				{
					code: "session_required",
				} satisfies Partial<SessionAccessError>,
			);
			await owner.query(
				'update "user" set two_factor_enabled = true where id = $1',
				[user.id],
			);
			await expect(
				getRequiredSessionFromHeaders(sessionHeaders(response)),
			).resolves.toMatchObject({
				userId: user.id,
			});
			const replay = await authRequest("/sign-in/email", {
				email: user.email,
				password,
			});
			expect(replay.status).toBeGreaterThanOrEqual(400);
			const audit = await owner.query(
				"select 1 from audit_logs where record_id = $1 and action = 'user.password_changed'",
				[user.id],
			);
			expect(audit.rowCount).toBe(1);
		});

		it("set revokes target sessions", async () => {
			const tenant = await freshTenant();
			const target = await enable(tenant.operator.userId);
			await login(target);
			await login(target);
			expect(await sessionCount(target.id)).toBe(2);

			const outcome = await withUserTransaction(tenant.bureauAdmin, (client) =>
				setTemporaryCredentials(client, tenant.bureauAdmin.userId, {
					targetId: target.id,
					bureauId: tenant.bureau.id,
					password: chosen,
				}),
			);

			expect(outcome).toEqual({ ok: true });
			expect(await sessionCount(target.id)).toBe(0);
			expect(await mustChange(target.id)).toBe(true);
			await login(target, chosen);
		});

		it("audit never holds the password or the hash", async () => {
			const tenant = await freshTenant();
			const target = await enable(tenant.operator.userId);
			await withUserTransaction(tenant.bureauAdmin, async (client) => {
				await setTemporaryCredentials(client, tenant.bureauAdmin.userId, {
					targetId: target.id,
					bureauId: tenant.bureau.id,
					password: chosen,
				});
				await setTemporaryCredentials(client, tenant.bureauAdmin.userId, {
					targetId: target.id,
					bureauId: tenant.bureau.id,
					password: null,
				});
			});

			const { rows } = await owner.query<{ action: string; metadata: unknown }>(
				"select action, metadata from audit_logs where record_id = $1 order by created_at, action",
				[target.id],
			);
			const stored = await owner.query<{ password: string }>(
				"select password from account where user_id = $1",
				[target.id],
			);
			expect(rows.map((row) => row.action).sort()).toEqual([
				"user.force_password_change",
				"user.password_set",
			]);
			const dump = JSON.stringify(rows);
			expect(dump).not.toContain(chosen);
			expect(dump).not.toContain(stored.rows[0].password);
		});

		it("rejects a change to the same password; flag and password stay", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);
			const headers = await login(user);

			const response = await authRequest(
				"/change-password",
				{ currentPassword: password, newPassword: password },
				headers,
			);

			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				code: "PASSWORD_UNCHANGED",
			});
			expect(await mustChange(user.id)).toBe(true);
			expect(await sessionCount(user.id)).toBe(1);
			await login(user);
		});

		it("a failed change (wrong current password) leaves the flag set", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);
			const headers = await login(user);

			const response = await authRequest(
				"/change-password",
				{ currentPassword: "wrong-current-password", newPassword: chosen },
				headers,
			);

			expect(response.status).toBe(400);
			expect(await mustChange(user.id)).toBe(true);
			await login(user);
		});

		it("keeps the response and the new session when clearing the flag fails", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);
			const headers = await login(user);
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			clearFlag.fail = true;
			let response: Response;
			try {
				response = await authRequest(
					"/change-password",
					{ currentPassword: password, newPassword: chosen },
					headers,
				);
			} finally {
				clearFlag.fail = false;
			}

			expect(response.status).toBe(200);
			expect(await mustChange(user.id)).toBe(true);
			expect(logged).toHaveBeenCalled();
			expect(JSON.stringify(logged.mock.calls)).not.toContain(chosen);
			logged.mockRestore();
			await owner.query(
				'update "user" set two_factor_enabled = true where id = $1',
				[user.id],
			);
			await expect(
				getRequiredSessionFromHeaders(sessionHeaders(response)),
			).rejects.toMatchObject({
				code: "password_change_required",
			} satisfies Partial<SessionAccessError>);
			await login(user, chosen);
		});

		it("an e-mail password reset clears the flag", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			await setMustChange(user.id, true);
			await authRequest("/request-password-reset", {
				email: user.email,
				redirectTo: "http://localhost:3000/auth/reset-password",
			});
			const { rows } = await pool.query<{ identifier: string }>(
				"select identifier from verification where value = $1 and identifier like 'reset-password:%'",
				[user.id],
			);
			const token = rows[0].identifier.replace("reset-password:", "");

			const response = await authRequest("/reset-password", {
				token,
				newPassword: chosen,
			});

			expect(response.status).toBe(200);
			expect(await mustChange(user.id)).toBe(false);
		});
	});

	describe("MFA enrolment", () => {
		// Plain TOTP secret of the user: the enrol URI carries it base32-encoded.
		async function enrolWithTotp(
			user: TestUser,
			headers: Headers,
		): Promise<{ response: Response; code: () => Promise<string> }> {
			const enableResponse = await authRequest(
				"/two-factor/enable",
				{ password },
				headers,
			);
			expect(enableResponse.status).toBe(200);
			const { totpURI } = (await enableResponse.json()) as { totpURI: string };
			const encoded = new URL(totpURI).searchParams.get("secret") ?? "";
			const secret = new TextDecoder().decode(base32.decode(encoded));
			const code = () => createOTP(secret).totp();
			const response = await authRequest(
				"/two-factor/verify-totp",
				{ code: await code() },
				headers,
			);
			return { response, code };
		}

		it("enrolling revokes the sessions opened before it", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			const stale = await login(user);
			const enrolling = await login(user);
			expect(await sessionCount(user.id)).toBe(2);

			const { response } = await enrolWithTotp(user, enrolling);

			expect(response.status).toBe(200);
			await expect(getRequiredSessionFromHeaders(stale)).rejects.toMatchObject({
				code: "session_required",
			} satisfies Partial<SessionAccessError>);
			expect(await sessionCount(user.id)).toBe(1);
			await expect(
				getRequiredSessionFromHeaders(sessionHeaders(response)),
			).resolves.toMatchObject({
				userId: user.id,
				mfaComplete: true,
			});
		});

		it("signing in with TOTP keeps the other sessions", async () => {
			const tenant = await freshTenant();
			const user = await enable(tenant.operator.userId);
			const { code, response } = await enrolWithTotp(user, await login(user));
			const enrolled = sessionHeaders(response);

			const signIn = await authRequest("/sign-in/email", {
				email: user.email,
				password,
			});
			const challenge = new Headers({
				cookie: signIn.headers
					.getSetCookie()
					.map((cookie) => cookie.split(";", 1)[0])
					.join("; "),
			});
			const verified = await authRequest(
				"/two-factor/verify-totp",
				{ code: await code() },
				challenge,
			);

			expect(verified.status).toBe(200);
			expect(await sessionCount(user.id)).toBe(2);
			await expect(
				getRequiredSessionFromHeaders(enrolled),
			).resolves.toMatchObject({ userId: user.id });
		});
	});
});

// O trigger protect_profile_identity barra a flag até para o dono: o seed usa replica.
async function setMustChange(userId: string, value: boolean) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query(
			"update profiles set must_change_password = $2 where id = $1",
			[userId, value],
		);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

async function mustChange(userId: string): Promise<boolean> {
	const { rows } = await owner.query<{ flag: boolean }>(
		"select must_change_password as flag from profiles where id = $1",
		[userId],
	);
	return rows[0].flag;
}

async function sessionCount(userId: string): Promise<number> {
	const { rows } = await owner.query<{ n: number }>(
		'select count(*)::int as n from "session" where user_id = $1',
		[userId],
	);
	return rows[0].n;
}
