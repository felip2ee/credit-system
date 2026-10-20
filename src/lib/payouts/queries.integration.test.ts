// Repasse sob RLS contra um Postgres real: tradução do resultado das funções SQL, auditoria e isolamento por Bureau.
import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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
import { seedPayableEntry, seedSuperadmin, seedSupportSession, seedTenant } from "@/test/seed";

import {
	cancelPayout,
	createPayout,
	getPayout,
	getPayoutReceiptRef,
	listPayouts,
	markPayoutPaid,
} from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");
const sha = () => createHash("sha256").update(randomUUID()).digest("hex");
const receipt = () => ({ objectKey: `ab/${randomUUID()}`, mime: "application/pdf" as const, sha256: sha() });

async function seedAccrual(bureauId: string, amount: string) {
	await seedPayableEntry(owner, { bureauId, kind: "accrual", amount });
}

async function setup(amount = "40.00") {
	const superadmin = await seedSuperadmin(owner);
	const tenant = await seedTenant(owner, "payq");
	await seedAccrual(tenant.bureau.id, amount);
	return { superadmin, tenant };
}

async function auditRows(action: string, targetId: string) {
	const { rows } = await owner.query<{ bureau_id: string | null; metadata: Record<string, unknown>; user_id: string }>(
		"select bureau_id, metadata, user_id from audit_logs where action = $1 and record_id = $2",
		[action, targetId],
	);
	return rows;
}

describe("createPayout", () => {
	it("creates the payout and audits it with the target Bureau in bureau_id", async () => {
		const { superadmin, tenant } = await setup();

		const result = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });

		expect(result).toMatchObject({ ok: true, amount: "40.00" });
		if (!result.ok) return;
		const audit = await auditRows("payout.create", result.payoutId);
		expect(audit).toHaveLength(1);
		expect(audit[0].user_id).toBe(superadmin.userId);
		expect(audit[0].bureau_id).toBe(tenant.bureau.id);
		expect(audit[0].metadata).toMatchObject({ amount: "40.00" });
	});

	it("returns nothing_to_pay and writes no audit when there is nothing to pay", async () => {
		const superadmin = await seedSuperadmin(owner);
		const tenant = await seedTenant(owner, "payempty");

		const result = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });

		expect(result).toEqual({ ok: false, reason: "nothing_to_pay" });
	});

	it("refuses a bureau_admin and a superadmin in a support session (not_allowed)", async () => {
		const { superadmin, tenant } = await setup();
		const supportSessionId = await seedSupportSession(owner, { superadminId: superadmin.userId, bureauId: tenant.bureau.id });

		const asAdmin = await createPayout(tenant.bureauAdmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		const inSupport = await createPayout(
			{ ...superadmin, bureauId: tenant.bureau.id, supportSessionId },
			{ bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE },
		);

		expect(asAdmin).toEqual({ ok: false, reason: "not_allowed" });
		expect(inSupport).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("markPayoutPaid", () => {
	it("pays an open payout, audits it, and reports no replay", async () => {
		const { superadmin, tenant } = await setup();
		const created = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!created.ok) throw new Error("setup");

		const result = await markPayoutPaid(superadmin, { payoutId: created.payoutId, receipt: receipt() });

		expect(result).toEqual({ ok: true, bureauId: tenant.bureau.id, replayed: false });
		const audit = await auditRows("payout.pay", created.payoutId);
		expect(audit).toHaveLength(1);
		expect(audit[0].bureau_id).toBe(tenant.bureau.id);
		expect(JSON.stringify(audit[0].metadata)).not.toMatch(/ab\/|sha|mime|pdf/i);
	});

	it("flags a same-receipt repeat as replayed and audits once; a different receipt is already_paid", async () => {
		const { superadmin, tenant } = await setup();
		const created = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!created.ok) throw new Error("setup");
		const first = receipt();
		await markPayoutPaid(superadmin, { payoutId: created.payoutId, receipt: first });

		const repeat = await markPayoutPaid(superadmin, {
			payoutId: created.payoutId,
			receipt: { ...first, objectKey: `ab/${randomUUID()}` },
		});
		const other = await markPayoutPaid(superadmin, { payoutId: created.payoutId, receipt: receipt() });

		expect(repeat).toMatchObject({ ok: true, replayed: true });
		expect(other).toEqual({ ok: false, reason: "already_paid" });
		expect(await auditRows("payout.pay", created.payoutId)).toHaveLength(1);
	});

	it("maps not_found and invalid_state (cancelled)", async () => {
		const { superadmin, tenant } = await setup();
		const created = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!created.ok) throw new Error("setup");
		await cancelPayout(superadmin, created.payoutId);

		expect(await markPayoutPaid(superadmin, { payoutId: created.payoutId, receipt: receipt() })).toEqual({
			ok: false,
			reason: "invalid_state",
		});
		expect(await markPayoutPaid(superadmin, { payoutId: randomUUID(), receipt: receipt() })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});

describe("cancelPayout", () => {
	it("cancels an open payout and audits it; a paid payout is invalid_state", async () => {
		const { superadmin, tenant } = await setup();
		const open = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!open.ok) throw new Error("setup");

		const cancelled = await cancelPayout(superadmin, open.payoutId);
		expect(cancelled).toEqual({ ok: true, bureauId: tenant.bureau.id });
		expect((await auditRows("payout.cancel", open.payoutId)).map((r) => r.bureau_id)).toEqual([tenant.bureau.id]);

		await seedAccrual(tenant.bureau.id, "10.00");
		const second = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!second.ok) throw new Error("setup");
		await markPayoutPaid(superadmin, { payoutId: second.payoutId, receipt: receipt() });
		expect(await cancelPayout(superadmin, second.payoutId)).toEqual({ ok: false, reason: "invalid_state" });
	});
});

describe("cancelPayout replay", () => {
	it("returns ok for an already cancelled payout without a second audit event", async () => {
		const { superadmin, tenant } = await setup();
		const open = await createPayout(superadmin, { bureauId: tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!open.ok) throw new Error("setup");

		const first = await cancelPayout(superadmin, open.payoutId);
		const second = await cancelPayout(superadmin, open.payoutId);

		expect(first).toEqual({ ok: true, bureauId: tenant.bureau.id });
		expect(second).toEqual({ ok: true, bureauId: tenant.bureau.id });
		expect(await auditRows("payout.cancel", open.payoutId)).toHaveLength(1);
		expect(await cancelPayout(superadmin, randomUUID())).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("reads are tenant-scoped", () => {
	it("the bureau_admin lists and gets only its own payouts; operator and client read none", async () => {
		const a = await setup();
		const b = await setup("15.00");
		const pa = await createPayout(a.superadmin, { bureauId: a.tenant.bureau.id, cutoffAt: FAR_FUTURE });
		const pb = await createPayout(b.superadmin, { bureauId: b.tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!pa.ok || !pb.ok) throw new Error("setup");

		const adminA = a.tenant.bureauAdmin;
		const listed = await withUserTransaction(adminA, (c) => listPayouts(c));
		const ownGet = await withUserTransaction(adminA, (c) => getPayout(c, pa.payoutId));
		const otherGet = await withUserTransaction(adminA, (c) => getPayout(c, pb.payoutId));
		const operatorList = await withUserTransaction(a.tenant.operator, (c) => listPayouts(c));
		const clientList = await withUserTransaction(a.tenant.client, (c) => listPayouts(c));

		expect(listed.map((p) => p.id)).toEqual([pa.payoutId]);
		expect(ownGet).toMatchObject({ id: pa.payoutId, status: "open", hasReceipt: false });
		expect(otherGet).toBeNull();
		expect(operatorList).toEqual([]);
		expect(clientList).toEqual([]);
	});

	it("getPayoutReceiptRef: own paid payout resolves; another Bureau's, unpaid, and support session do not", async () => {
		const a = await setup();
		const b = await setup("15.00");
		const pa = await createPayout(a.superadmin, { bureauId: a.tenant.bureau.id, cutoffAt: FAR_FUTURE });
		const pb = await createPayout(b.superadmin, { bureauId: b.tenant.bureau.id, cutoffAt: FAR_FUTURE });
		if (!pa.ok || !pb.ok) throw new Error("setup");
		const ra = receipt();
		await markPayoutPaid(a.superadmin, { payoutId: pa.payoutId, receipt: ra });
		await markPayoutPaid(b.superadmin, { payoutId: pb.payoutId, receipt: receipt() });

		const own = await withUserTransaction(a.tenant.bureauAdmin, (c) => getPayoutReceiptRef(c, pa.payoutId));
		const cross = await withUserTransaction(a.tenant.bureauAdmin, (c) => getPayoutReceiptRef(c, pb.payoutId));
		const asSuper = await withUserTransaction(a.superadmin, (c) => getPayoutReceiptRef(c, pb.payoutId));
		const supportSessionId = await seedSupportSession(owner, {
			superadminId: a.superadmin.userId,
			bureauId: b.tenant.bureau.id,
		});
		const inSupport = await withUserTransaction(
			{ ...a.superadmin, bureauId: b.tenant.bureau.id, supportSessionId },
			(c) => getPayoutReceiptRef(c, pb.payoutId),
		);

		expect(own).toEqual({ bureauId: a.tenant.bureau.id, objectKey: ra.objectKey, mime: "application/pdf" });
		expect(cross).toBeNull();
		expect(asSuper).toMatchObject({ bureauId: b.tenant.bureau.id });
		expect(inSupport).toBeNull();
	});
});
