import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: { current: null as unknown } }));

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
import { seedTenant, type SeededTenant } from "@/test/seed";

import { setUserActive, setUserRole } from "./users";

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

	it("does not demote the last admin that can log in, then allows it with another one", async () => {
		const tenant = await seedTenant(owner, "team");
		const target = await addActiveAdmin(tenant);
		actAs(tenant.bureauAdmin);

		await expect(setUserRole({ userId: target, role: "operator" })).resolves.toEqual({ error: LAST_ADMIN });
		expect(await profileOf(target)).toEqual({ role: "bureau_admin", is_active: true });

		await addAccount(tenant.bureauAdmin.userId);
		await expect(setUserRole({ userId: target, role: "operator" })).resolves.toEqual({ error: null });
		expect(await profileOf(target)).toEqual({ role: "operator", is_active: true });
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
