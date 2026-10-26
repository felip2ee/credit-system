import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedSupportSession, seedTenant } from "@/test/seed";

import { deleteSettings, upsertSettings } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

describe("settings writes", () => {
	it("audit without bureau or support session while the superadmin is in a support session", async () => {
		const superadmin = await seedSuperadmin(owner);
		const tenant = await seedTenant(owner, "settings");
		const sessionId = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: tenant.bureau.id,
		});
		const inSupport = { ...superadmin, bureauId: tenant.bureau.id, supportSessionId: sessionId };
		const key = `test.${superadmin.userId}`;

		await upsertSettings(inSupport, [{ key, value: 1 }], "settings.update");
		await deleteSettings(inSupport, [key], "settings.delete");

		const { rows } = await owner.query(
			"select action, bureau_id, support_session_id from audit_logs where user_id = $1 order by action",
			[superadmin.userId],
		);
		expect(rows).toEqual([
			{ action: "settings.delete", bureau_id: null, support_session_id: null },
			{ action: "settings.update", bureau_id: null, support_session_id: null },
		]);
	});

	it("auditChange gets the stored value and its result joins the audit metadata", async () => {
		const superadmin = await seedSuperadmin(owner);
		const key = `test.change.${superadmin.userId}`;
		const change = (previous: Map<string, unknown>) => ({ from: previous.get(key) ?? null, to: 2 });

		await upsertSettings(superadmin, [{ key, value: 1 }], "settings.update");
		await upsertSettings(superadmin, [{ key, value: 2 }], "settings.payable_retention", { auditChange: change });

		const { rows } = await owner.query(
			"select metadata from audit_logs where user_id = $1 and action = 'settings.payable_retention'",
			[superadmin.userId],
		);
		expect(rows[0].metadata).toEqual({ keys: [key], from: 1, to: 2 });
	});
});
