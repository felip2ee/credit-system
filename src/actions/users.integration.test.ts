import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: { current: null as unknown } }));

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system_test",
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

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
	auth: { api: { requestPasswordReset: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: async () => mocks.session.current,
}));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { auth } from "@/lib/auth/server";
import { seedTenant, type SeededTenant } from "@/test/seed";

import { inviteTeamMember, setTeamMemberCredentials, setUserActive, setUserRole } from "./users";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });
const LAST_ADMIN = "O Bureau precisa de ao menos um administrador ativo.";

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

beforeEach(() => {
	mocks.session.current = null;
});

function actAs(identity: SeededTenant["bureauAdmin"] | SeededTenant["operator"]) {
	mocks.session.current = { ...identity, supportSessionId: null };
}

async function addAccount(userId: string) {
	await owner.query(
		"insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
		[randomUUID(), userId],
	);
}

// Segundo administrador do Bureau, já com conta (consegue entrar).
async function addActiveAdmin(tenant: SeededTenant): Promise<string> {
	const id = randomUUID();
	await owner.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
		id,
		"Segundo Admin",
		`${id}@example.test`,
	]);
	await owner.query(
		`insert into profiles (id, auth_user_id, full_name, email, role, bureau_id)
		 values ($1::uuid, $1::text, 'Segundo Admin', $2, 'bureau_admin', $3)`,
		[id, `${id}@example.test`, tenant.bureau.id],
	);
	await addAccount(id);
	return id;
}

async function addSession(userId: string) {
	await owner.query(
		`insert into "session" (id, expires_at, token, updated_at, user_id)
		 values ($1, now() + interval '1 hour', $1, now(), $2)`,
		[randomUUID(), userId],
	);
}

async function profileOf(id: string) {
	const { rows } = await owner.query<{ role: string; is_active: boolean }>(
		"select role::text, is_active from profiles where id = $1",
		[id],
	);
	return rows[0];
}

async function sessionCount(userId: string) {
	const { rows } = await owner.query<{ n: number }>(
		'select count(*)::int as n from "session" where user_id = $1',
		[userId],
	);
	return rows[0].n;
}

async function auditActions(targetId: string) {
	const { rows } = await owner.query<{ action: string; bureau_id: string | null }>(
		"select action, bureau_id from audit_logs where record_id = $1 order by action",
		[targetId],
	);
	return rows;
}

describe("team actions against the database", () => {
	it("blocks an operator from every action and changes nothing", async () => {
		const tenant = await seedTenant(owner, "team");
		actAs(tenant.operator);

		const results = await Promise.all([
			setUserRole({ userId: tenant.bureauAdmin.userId, role: "operator" }),
			setUserActive({ userId: tenant.bureauAdmin.userId, isActive: false }),
		]);

		for (const result of results) expect(result.error).toBeTruthy();
		expect(await profileOf(tenant.bureauAdmin.userId)).toEqual({ role: "bureau_admin", is_active: true });
	});

	it("does not count a pending admin as the remaining admin (deactivate)", async () => {
		const tenant = await seedTenant(owner, "team");
		const target = await addActiveAdmin(tenant);
		actAs(tenant.bureauAdmin); // sem conta: convite pendente, não consegue entrar

		await expect(setUserActive({ userId: target, isActive: false })).resolves.toEqual({ error: LAST_ADMIN });
		expect(await profileOf(target)).toEqual({ role: "bureau_admin", is_active: true });

		await addAccount(tenant.bureauAdmin.userId);
		await expect(setUserActive({ userId: target, isActive: false })).resolves.toEqual({ error: null });
		expect(await profileOf(target)).toEqual({ role: "bureau_admin", is_active: false });
	});

	it("refuses to demote an admin, even when another admin can log in", async () => {
		const tenant = await seedTenant(owner, "team");
		const target = await addActiveAdmin(tenant);
		await addAccount(tenant.bureauAdmin.userId);
		await addSession(target);
		actAs(tenant.bureauAdmin);

		await expect(setUserRole({ userId: target, role: "operator" })).resolves.toEqual({
			error: "Só é possível promover operador a administrador.",
		});

		expect(await profileOf(target)).toEqual({ role: "bureau_admin", is_active: true });
		expect(await sessionCount(target)).toBe(1);
		expect(await auditActions(target)).toEqual([]);
	});

	it("deletes the target sessions and audits a role change", async () => {
		const tenant = await seedTenant(owner, "team");
		await addAccount(tenant.bureauAdmin.userId);
		await addSession(tenant.operator.userId);
		actAs(tenant.bureauAdmin);

		await expect(setUserRole({ userId: tenant.operator.userId, role: "bureau_admin" })).resolves.toEqual({
			error: null,
		});

		expect(await sessionCount(tenant.operator.userId)).toBe(0);
		expect(await auditActions(tenant.operator.userId)).toEqual([
			{ action: "user.role_change", bureau_id: tenant.bureau.id },
		]);
	});

	it("deletes the target sessions and audits a deactivation", async () => {
		const tenant = await seedTenant(owner, "team");
		await addSession(tenant.operator.userId);
		actAs(tenant.bureauAdmin);

		await expect(setUserActive({ userId: tenant.operator.userId, isActive: false })).resolves.toEqual({
			error: null,
		});

		expect(await sessionCount(tenant.operator.userId)).toBe(0);
		expect(await auditActions(tenant.operator.userId)).toEqual([
			{ action: "user.deactivate", bureau_id: tenant.bureau.id },
		]);
	});

	it("does not touch a user of another bureau", async () => {
		const tenant = await seedTenant(owner, "team");
		const other = await seedTenant(owner, "team-other");
		actAs(tenant.bureauAdmin);

		await expect(setUserActive({ userId: other.operator.userId, isActive: false })).resolves.toEqual({
			error: "Usuário não encontrado.",
		});
		expect(await profileOf(other.operator.userId)).toEqual({ role: "operator", is_active: true });
	});
});

describe("team credentials against the database", () => {
	const temporary = "temporary-password-12";

	async function credentialOf(userId: string) {
		const { rows } = await owner.query<{ password: string | null; flag: boolean }>(
			`select (select a.password from account a where a.user_id = p.auth_user_id) as password,
			        p.must_change_password as flag
			   from profiles p where p.id = $1`,
			[userId],
		);
		return rows[0];
	}

	it("lets a bureau_admin set the password of an operator", async () => {
		const tenant = await seedTenant(owner, "cred");
		await addAccount(tenant.operator.userId);
		await addSession(tenant.operator.userId);
		actAs(tenant.bureauAdmin);

		await expect(
			setTeamMemberCredentials({ userId: tenant.operator.userId, password: temporary }),
		).resolves.toEqual({ error: null });

		const credential = await credentialOf(tenant.operator.userId);
		expect(credential.flag).toBe(true);
		expect(credential.password).not.toBe("hash");
		expect(credential.password).not.toContain(temporary);
		expect(await sessionCount(tenant.operator.userId)).toBe(0);
		expect(await auditActions(tenant.operator.userId)).toEqual([
			{ action: "user.password_set", bureau_id: tenant.bureau.id },
		]);
	});

	it("team: peer admin, self and other bureau are refused", async () => {
		const tenant = await seedTenant(owner, "cred");
		const other = await seedTenant(owner, "cred-other");
		const peer = await addActiveAdmin(tenant);
		await addAccount(tenant.bureauAdmin.userId);
		await addAccount(other.operator.userId);
		actAs(tenant.bureauAdmin);

		for (const userId of [peer, tenant.bureauAdmin.userId, other.operator.userId]) {
			const result = await setTeamMemberCredentials({ userId, password: temporary });
			expect(result.error).toBeTruthy();
			expect(await credentialOf(userId)).toEqual({ password: "hash", flag: false });
		}
	});

	it("blocks an operator from setting a password", async () => {
		const tenant = await seedTenant(owner, "cred");
		await addAccount(tenant.operator.userId);
		actAs(tenant.operator);

		await expect(
			setTeamMemberCredentials({ userId: tenant.operator.userId, password: temporary }),
		).resolves.toEqual({ error: "Sem permissão para gerenciar a equipe." });
		expect(await credentialOf(tenant.operator.userId)).toEqual({ password: "hash", flag: false });
	});

	it("refuses to force a change on a pending invite", async () => {
		const tenant = await seedTenant(owner, "cred");
		actAs(tenant.bureauAdmin);

		const result = await setTeamMemberCredentials({ userId: tenant.operator.userId });

		expect(result.error).toBeTruthy();
		expect(await credentialOf(tenant.operator.userId)).toEqual({ password: null, flag: false });
	});

	it("creates a member with a password and sends no e-mail", async () => {
		const tenant = await seedTenant(owner, "cred");
		actAs(tenant.bureauAdmin);
		const email = `membro-${randomUUID()}@example.test`;

		const result = await inviteTeamMember({
			fullName: "Novo Membro",
			email,
			role: "operator",
			password: temporary,
		});

		expect(result).toEqual({ error: null, email, invited: false });
		expect(auth.api.requestPasswordReset).not.toHaveBeenCalled();
		const { rows } = await owner.query<{ id: string }>("select id from profiles where email = $1", [email]);
		const credential = await credentialOf(rows[0].id);
		expect(credential.flag).toBe(true);
		expect(credential.password).toBeTruthy();
	});
});
