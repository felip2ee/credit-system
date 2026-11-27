// Interruptor do afiliado (075) contra um Postgres real: padrão desligado, quem liga, auditoria, RLS entre bureaus e a % intocada.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedSupportSession, seedTenant, type SeedSuperadmin, type SeededTenant } from "@/test/seed";

import { isAffiliateEnabled, isAffiliateSectionOpen, setAffiliateEnabled } from "./enabled";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let A: SeededTenant;
let B: SeededTenant;
let SA: SeedSuperadmin;

beforeAll(async () => {
	[A, B, SA] = await Promise.all([seedTenant(owner, "Enabled A"), seedTenant(owner, "Enabled B"), seedSuperadmin(owner)]);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const stored = async (bureauId: string) =>
	(await owner.query<{ affiliate_enabled: boolean; default_pct: string }>(
		"select affiliate_enabled, default_pct from bureau_affiliate_settings where bureau_id = $1",
		[bureauId],
	)).rows[0];

describe("affiliate switch", () => {
	it("is off by default for every role of the bureau, with or without a settings row", async () => {
		expect(await isAffiliateEnabled(A.client)).toBe(false);
		expect(await isAffiliateEnabled(A.bureauAdmin)).toBe(false);
		expect(await isAffiliateSectionOpen(A.client)).toBe(false);
		expect(await stored(A.bureau.id)).toBeUndefined();
	});

	it("does not let an operator or a client turn it on", async () => {
		for (const who of [A.operator, A.client]) {
			expect((await setAffiliateEnabled(who, { enabled: true })).error).toMatch(/permissão/);
		}
		expect(await isAffiliateEnabled(A.client)).toBe(false);
	});

	it("lets the bureau_admin turn it on and off, audits each change, and the client sees it", async () => {
		expect((await setAffiliateEnabled(A.bureauAdmin, { enabled: true })).error).toBeNull();
		expect(await isAffiliateEnabled(A.client)).toBe(true);
		expect(await isAffiliateSectionOpen(A.client)).toBe(true);
		expect(await isAffiliateEnabled(B.client)).toBe(false);

		expect((await setAffiliateEnabled(A.bureauAdmin, { enabled: false })).error).toBeNull();
		expect(await isAffiliateEnabled(A.client)).toBe(false);

		const audit = await owner.query<{ metadata: { from: boolean; to: boolean; bureau_id: string } }>(
			"select metadata from audit_logs where action = 'affiliate.enabled' and record_id = $1 order by created_at",
			[A.bureau.id],
		);
		expect(audit.rows.map((r) => [r.metadata.from, r.metadata.to])).toEqual([
			[false, true],
			[true, false],
		]);
		expect(audit.rows[0].metadata.bureau_id).toBe(A.bureau.id);
	});

	it("keeps the platform default_pct: the bureau_admin cannot change it", async () => {
		await owner.query("update bureau_affiliate_settings set default_pct = 7 where bureau_id = $1", [A.bureau.id]);
		expect((await setAffiliateEnabled(A.bureauAdmin, { enabled: true })).error).toBeNull();
		expect((await stored(A.bureau.id)).default_pct).toBe("7.00");

		await expect(
			withUserTransaction(A.bureauAdmin, (c) =>
				c.query("update bureau_affiliate_settings set default_pct = 50 where bureau_id = $1", [A.bureau.id]),
			),
		).rejects.toMatchObject({ code: "42501" });
		expect((await stored(A.bureau.id)).default_pct).toBe("7.00");
	});

	it("does not let a bureau_admin write another bureau's row", async () => {
		await expect(
			withUserTransaction(A.bureauAdmin, (c) =>
				c.query("insert into bureau_affiliate_settings (bureau_id, affiliate_enabled, updated_by) values ($1, true, $2)", [
					B.bureau.id,
					A.bureauAdmin.userId,
				]),
			),
		).rejects.toMatchObject({ code: "42501" });
		expect(await stored(B.bureau.id)).toBeUndefined();
	});

	it("lets the superadmin switch a bureau outside support, audit without a bureau context, and refuses it in support", async () => {
		expect((await setAffiliateEnabled(SA, { enabled: true })).error).toMatch(/permissão/);
		expect((await setAffiliateEnabled(SA, { enabled: true, bureauId: B.bureau.id })).error).toBeNull();
		expect((await stored(B.bureau.id)).affiliate_enabled).toBe(true);
		expect(await isAffiliateEnabled(B.client)).toBe(true);

		const audit = await owner.query<{ metadata: { to: boolean } }>(
			"select metadata from audit_logs where action = 'affiliate.enabled' and record_id = $1",
			[B.bureau.id],
		);
		expect(audit.rows.map((r) => r.metadata.to)).toEqual([true]);

		const support = await seedSupportSession(owner, { superadminId: SA.userId, bureauId: B.bureau.id });
		const inSupport = { ...SA, bureauId: B.bureau.id, supportSessionId: support };
		expect((await setAffiliateEnabled(inSupport, { enabled: false, bureauId: B.bureau.id })).error).toMatch(/permissão/);
		expect((await stored(B.bureau.id)).affiliate_enabled).toBe(true);
	});
});
