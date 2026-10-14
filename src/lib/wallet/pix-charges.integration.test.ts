// Recarga PIX e webhook do Asaas contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system",
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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "i".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system",
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { POST } from "@/app/api/webhooks/asaas/route";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { buildFakePaymentEvent } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPixCharge, seedSuperadmin, seedTenant } from "@/test/seed";

import { countPendingPixCharges, createPixCharge, getPixCharge, listPixCharges, listRefundShortfalls } from "./pix-charges";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "i".repeat(32);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

function webhook(payload: unknown, token: string | null = TOKEN) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token !== null) headers.set(ASAAS_WEBHOOK_TOKEN_HEADER, token);
	return POST(
		new Request("http://localhost/api/webhooks/asaas", { method: "POST", headers, body: JSON.stringify(payload) }),
	);
}

async function balance(bureauId: string): Promise<string> {
	const { rows } = await owner.query<{ available: string }>("select available from wallets where bureau_id = $1", [
		bureauId,
	]);
	return rows[0].available;
}

async function eventCount(eventId: string): Promise<number> {
	const { rows } = await owner.query("select 1 from asaas_webhook_events where event_id = $1", [eventId]);
	return rows.length;
}

const evt = () => `evt_${randomUUID()}`;

describe("createPixCharge", () => {
	it("stores a pending charge for 30 minutes and audits the request", async () => {
		const tenant = await seedTenant(owner, "Pix A");
		const admin = tenant.bureauAdmin;

		const result = await withUserTransaction(admin, (c) =>
			createPixCharge(c, admin, { asaasPaymentId: `pay_${randomUUID()}`, pixPayload: "000201pix", amount: "100.00" }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { rows } = await owner.query<{ status: string; minutes: string; amount: string }>(
			"select status, amount, round(extract(epoch from (expires_at - created_at)) / 60)::text as minutes from pix_charges where id = $1",
			[result.id],
		);
		expect(rows[0]).toMatchObject({ status: "pending", minutes: "30", amount: "100.00" });
		const audit = await owner.query("select metadata from audit_logs where action = 'wallet.topup.request' and record_id = $1", [
			result.id,
		]);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("000201pix");
	});

	it.each(["9.99", "5000.01", "10.005", "x"])("rejects amount %s", async (amount) => {
		const tenant = await seedTenant(owner, "Pix B");
		const admin = tenant.bureauAdmin;

		const result = await withUserTransaction(admin, (c) =>
			createPixCharge(c, admin, { asaasPaymentId: `pay_${randomUUID()}`, pixPayload: "p", amount }),
		);

		expect(result).toEqual({ ok: false, reason: "invalid_amount" });
	});

	it("denies operator and client at the database", async () => {
		const tenant = await seedTenant(owner, "Pix C");
		for (const identity of [tenant.operator, tenant.client]) {
			await expect(
				withUserTransaction(identity, (c) =>
					createPixCharge(c, identity, { asaasPaymentId: `pay_${randomUUID()}`, pixPayload: "p", amount: "50.00" }),
				),
			).rejects.toThrow(/row-level security/);
		}
	});
});

describe("countPendingPixCharges", () => {
	it("counts only pending charges that have not expired, for the own Bureau", async () => {
		const tenant = await seedTenant(owner, "Pix F");
		const other = await seedTenant(owner, "Pix F2");
		const admin = tenant.bureauAdmin;
		const base = { bureauId: tenant.bureau.id, requestedBy: admin.userId };
		await seedPixCharge(owner, base);
		await seedPixCharge(owner, base);
		await seedPixCharge(owner, { ...base, expiresAt: new Date(Date.now() - 60_000) });
		await seedPixCharge(owner, { ...base, status: "paid" });
		await seedPixCharge(owner, { ...base, status: "cancelled" });
		await seedPixCharge(owner, { bureauId: other.bureau.id, requestedBy: other.bureauAdmin.userId });

		expect(await withUserTransaction(admin, (c) => countPendingPixCharges(c, tenant.bureau.id))).toBe(2);
	});
});

describe("pix_charges_pending_idx", () => {
	it("serves the countPendingPixCharges predicate", async () => {
		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local enable_seqscan = off");
			const { rows } = await client.query<{ "QUERY PLAN": string }>(
				"explain select count(*) from pix_charges where bureau_id = $1 and status = 'pending' and expires_at > now()",
				[randomUUID()],
			);
			expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("pix_charges_pending_idx");
		} finally {
			await client.query("rollback");
			client.release();
		}
	});
});

describe("listRefundShortfalls", () => {
	async function shortfallCharge(tenant: Awaited<ReturnType<typeof seedTenant>>, shortfall: string) {
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "100.00",
			status: "paid",
		});
		await owner.query("update pix_charges set status = 'refunded', refund_shortfall = $2 where id = $1", [charge.id, shortfall]);
		return charge;
	}

	it("lists only charges with an unrecovered refund, without Asaas ids, for the superadmin and the own Bureau", async () => {
		const tenant = await seedTenant(owner, "Shortfall A");
		const other = await seedTenant(owner, "Shortfall B");
		const superadmin = await seedSuperadmin(owner);
		const short = await shortfallCharge(tenant, "30.00");
		await shortfallCharge(tenant, "0.00");
		await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		await shortfallCharge(other, "50.00");

		const asSuperadmin = await withUserTransaction(superadmin, (c) => listRefundShortfalls(c, tenant.bureau.id));
		const asAdmin = await withUserTransaction(tenant.bureauAdmin, (c) => listRefundShortfalls(c, tenant.bureau.id));

		for (const rows of [asSuperadmin, asAdmin]) {
			expect(rows).toEqual([{ chargeId: short.id, amount: "100.00", shortfall: "30.00", createdAt: expect.any(Date) }]);
			expect(JSON.stringify(rows)).not.toContain(short.asaasPaymentId);
		}
	});

	it("hides other Bureaus from a Bureau admin and from an operator, and charges with no shortfall from the superadmin", async () => {
		const tenant = await seedTenant(owner, "Shortfall C");
		const other = await seedTenant(owner, "Shortfall D");
		const superadmin = await seedSuperadmin(owner);
		await shortfallCharge(other, "50.00");
		await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });

		expect(await withUserTransaction(tenant.bureauAdmin, (c) => listRefundShortfalls(c, other.bureau.id))).toEqual([]);
		expect(await withUserTransaction(tenant.operator, (c) => listRefundShortfalls(c, other.bureau.id))).toEqual([]);
		expect(await withUserTransaction(superadmin, (c) => listRefundShortfalls(c, tenant.bureau.id))).toEqual([]);
		const { rows } = await owner.query("select 1 from pix_charges where bureau_id = $1", [tenant.bureau.id]);
		expect(rows).toHaveLength(1);
	});
});

describe("getPixCharge / listPixCharges", () => {
	it("derives expired from a pending charge past its expiry and hides the Asaas id", async () => {
		const tenant = await seedTenant(owner, "Pix D");
		const admin = tenant.bureauAdmin;
		const live = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: admin.userId });
		const old = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: admin.userId,
			expiresAt: new Date(Date.now() - 60_000),
		});

		const liveCharge = await withUserTransaction(admin, (c) => getPixCharge(c, live.id));
		const oldCharge = await withUserTransaction(admin, (c) => getPixCharge(c, old.id));
		const list = await withUserTransaction(admin, (c) => listPixCharges(c, tenant.bureau.id));

		expect(liveCharge?.status).toBe("pending");
		expect(oldCharge?.status).toBe("expired");
		expect(list.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
		expect(JSON.stringify([liveCharge, oldCharge, list])).not.toContain(live.asaasPaymentId);
	});

	it("does not return a charge of another Bureau", async () => {
		const mine = await seedTenant(owner, "Pix E1");
		const other = await seedTenant(owner, "Pix E2");
		const charge = await seedPixCharge(owner, { bureauId: other.bureau.id, requestedBy: other.bureauAdmin.userId });

		expect(await withUserTransaction(mine.bureauAdmin, (c) => getPixCharge(c, charge.id))).toBeNull();
	});
});

describe("POST /api/webhooks/asaas", () => {
	it("rejects a bad token with 401 and writes no event", async () => {
		const tenant = await seedTenant(owner, "Hook A");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		const eventId = evt();

		for (const token of [null, "wrong", "i".repeat(31)]) {
			expect((await webhook(buildFakePaymentEvent({ eventId, asaasPaymentId: charge.asaasPaymentId, value: 100 }), token)).status).toBe(401);
		}

		expect(await eventCount(eventId)).toBe(0);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
	});

	it("credits the stored amount, not the payload amount", async () => {
		const tenant = await seedTenant(owner, "Hook B");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "100.00",
		});

		const response = await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 9999 }));

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		const { rows } = await owner.query("select status from pix_charges where id = $1", [charge.id]);
		expect(rows[0].status).toBe("paid");
	});

	it("records a neutral ledger reference, never the Asaas payment id", async () => {
		const tenant = await seedTenant(owner, "Hook B2");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });

		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100 }));

		const { rows } = await owner.query<{ reference: string }>(
			"select reference from ledger_entries where bureau_id = $1 and kind = 'topup'",
			[tenant.bureau.id],
		);
		expect(rows.map((r) => r.reference)).toEqual([`pix_charge:${charge.id}`]);
		expect(rows[0].reference).not.toContain(charge.asaasPaymentId);
	});

	it("parallel duplicate events credit once", async () => {
		const tenant = await seedTenant(owner, "Hook C");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		const payload = buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100 });

		const responses = await Promise.all([webhook(payload), webhook(payload), webhook(payload)]);

		expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		const { rows } = await owner.query("select 1 from ledger_entries where bureau_id = $1 and kind = 'topup'", [tenant.bureau.id]);
		expect(rows).toHaveLength(1);
	});

	it("paid after expiry still credits", async () => {
		const tenant = await seedTenant(owner, "Hook D");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			expiresAt: new Date(Date.now() - 3_600_000),
		});

		const response = await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100 }));

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
	});

	it("answers 200 and credits nothing for a cancelled charge", async () => {
		const tenant = await seedTenant(owner, "Hook E");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			status: "cancelled",
		});

		const response = await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100 }));

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
	});

	it("answers 200 and records an unknown payment without crediting", async () => {
		const eventId = evt();

		const response = await webhook(buildFakePaymentEvent({ eventId, asaasPaymentId: `pay_unknown_${randomUUID()}`, value: 100 }));

		expect(response.status).toBe(200);
		const { rows } = await owner.query("select result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(rows[0].result).toBe("unknown_charge");
	});

	it("records a non-payment event as ignored without crediting", async () => {
		const tenant = await seedTenant(owner, "Hook F");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		const eventId = evt();

		const response = await webhook(
			buildFakePaymentEvent({ eventId, asaasPaymentId: charge.asaasPaymentId, value: 100, event: "PAYMENT_CREATED" }),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		const { rows } = await owner.query("select result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(rows[0].result).toBe("ignored");
	});

	it("derives the event id from event and payment id when the body has none", async () => {
		const tenant = await seedTenant(owner, "Hook G");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		const body = { event: "PAYMENT_RECEIVED", payment: { object: "payment", id: charge.asaasPaymentId, value: 1 } };

		const responses = await Promise.all([webhook(body), webhook(body)]);

		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		expect(await eventCount(`PAYMENT_RECEIVED:${charge.asaasPaymentId}`)).toBe(1);
	});

	it("reverses a paid charge on PAYMENT_REFUNDED through the webhook pool", async () => {
		const tenant = await seedTenant(owner, "Hook H");
		const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100 }));

		const response = await webhook(
			buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 100, event: "PAYMENT_REFUNDED" }),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		const { rows } = await owner.query("select status from pix_charges where id = $1", [charge.id]);
		expect(rows[0].status).toBe("refunded");
	});

	it("stores no payload for an unknown payment", async () => {
		const eventId = evt();

		await webhook(buildFakePaymentEvent({ eventId, asaasPaymentId: `pay_unknown_${randomUUID()}`, value: 100 }));

		const { rows } = await owner.query("select payload, result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(rows[0]).toEqual({ payload: null, result: "unknown_charge" });
	});
});
