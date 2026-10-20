import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant } from "@/test/seed";

import { listAuditLogs } from "./read";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });
let tag: string;
let tenant: SeededTenant;
let other: SeededTenant;
let superadmin: Awaited<ReturnType<typeof seedSuperadmin>>;

function insertAudit(action: string, bureauId: string | null, supportSessionId: string | null, userId: string | null) {
	return owner.query(
		`insert into audit_logs (bureau_id, support_session_id, user_id, action) values ($1, $2, $3, $4)`,
		[bureauId, supportSessionId, userId, `${tag}.${action}`],
	);
}

beforeEach(async () => {
	tag = `t${Math.random().toString(36).slice(2, 8)}`;
	superadmin = await seedSuperadmin(owner);
	tenant = await seedTenant(owner, "auditread");
	other = await seedTenant(owner, "auditother");
	const supportId = await seedSupportSession(owner, { superadminId: superadmin.userId, bureauId: tenant.bureau.id });
	await insertAudit("tenant", tenant.bureau.id, null, tenant.bureauAdmin.userId);
	await insertAudit("other-tenant", other.bureau.id, null, other.bureauAdmin.userId);
	await insertAudit("platform", null, null, superadmin.userId);
	await insertAudit("support", tenant.bureau.id, supportId, superadmin.userId);
});

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

const mine = async (identity: Parameters<typeof listAuditLogs>[0], limit?: number) =>
	(await listAuditLogs(identity, limit)).map((l) => l.action).filter((a) => a.startsWith(`${tag}.`)).sort();

describe("listAuditLogs", () => {
	it("returns only the own bureau rows to the bureau_admin", async () => {
		await expect(mine(tenant.bureauAdmin)).resolves.toEqual([`${tag}.support`, `${tag}.tenant`]);
	});

	it("returns platform and support rows, never tenant-only rows, to the superadmin", async () => {
		await expect(mine(superadmin)).resolves.toEqual([`${tag}.platform`, `${tag}.support`]);
	});

	it("applies the limit to the superadmin union", async () => {
		const logs = await listAuditLogs(superadmin, 1);
		expect(logs).toHaveLength(1);
	});

	it("returns rows newest first", async () => {
		const logs = await listAuditLogs(superadmin, 50);
		const times = logs.map((l) => new Date(l.created_at).getTime());
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});
});
