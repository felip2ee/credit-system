// Recarga PIX e webhook do Asaas contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "i".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ??
			"postgres://app_webhook:test@localhost:54329/credit_system_test",
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
import { seedClientProfile, seedPixCharge, seedSuperadmin, seedTenant } from "@/test/seed";

import {
	bindAsaasCharge,
	countPendingClientPixCharges,
	countRecentCardAttempts,
	getChargeStatus,
	lockChargeScope,
	reserveCharge,
	setChargeCustomer,
	type ReserveChargeInput,
	cancelUnboundPixCharge,
	countPendingPixCharges,
	getPixCharge,
	listClientPixCharges,
	listPixCharges,
	listRefundShortfalls,
} from "./pix-charges";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "i".repeat(32);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

function webhook(payload: unknown, token: string | null = TOKEN) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token !== null) headers.set(ASAAS_WEBHOOK_TOKEN_HEADER, token);
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		}),
	);
}

async function balance(bureauId: string): Promise<string> {
	const { rows } = await owner.query<{ available: string }>(
		"select available from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0].available;
}

async function eventCount(eventId: string): Promise<number> {
	const { rows } = await owner.query(
		"select 1 from asaas_webhook_events where event_id = $1",
		[eventId],
	);
	return rows.length;
}

const evt = () => `evt_${randomUUID()}`;

describe("countPendingPixCharges", () => {
	it("counts only pending charges that have not expired, for the own Bureau", async () => {
		const tenant = await seedTenant(owner, "Pix F");
		const other = await seedTenant(owner, "Pix F2");
		const admin = tenant.bureauAdmin;
		const base = { bureauId: tenant.bureau.id, requestedBy: admin.userId };
		await seedPixCharge(owner, base);
		await seedPixCharge(owner, base);
		await seedPixCharge(owner, {
			...base,
			expiresAt: new Date(Date.now() - 60_000),
		});
		await seedPixCharge(owner, { ...base, status: "paid" });
		await seedPixCharge(owner, { ...base, status: "cancelled" });
		await seedPixCharge(owner, {
			bureauId: other.bureau.id,
			requestedBy: other.bureauAdmin.userId,
		});

		expect(
			await withUserTransaction(admin, (c) =>
				countPendingPixCharges(c, tenant.bureau.id),
			),
		).toBe(2);
	});
});

describe("pix_charges_pending_idx", () => {
	it("serves the countPendingPixCharges predicate", async () => {
		// O plano depende das estatísticas da tabela; a definição do índice é determinística.
		const { rows } = await owner.query<{ indexdef: string }>(
			"select indexdef from pg_indexes where tablename = 'pix_charges' and indexname = 'pix_charges_pending_idx'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].indexdef).toContain("(bureau_id, expires_at)");
		expect(rows[0].indexdef).toContain("status = 'pending'");
	});
});

describe("pix_charges_bureau_created_idx", () => {
	it("was dropped: pix_charges_bureau_own_created_idx serves the Bureau charge list", async () => {
		const { rows } = await owner.query<{ indexname: string }>(
			"select indexname from pg_indexes where tablename = 'pix_charges' and indexname in ('pix_charges_bureau_created_idx', 'pix_charges_bureau_own_created_idx')",
		);
		expect(rows.map((r) => r.indexname)).toEqual(["pix_charges_bureau_own_created_idx"]);
	});
});

describe("listRefundShortfalls", () => {
	async function shortfallCharge(
		tenant: Awaited<ReturnType<typeof seedTenant>>,
		shortfall: string,
	) {
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "100.00",
			status: "paid",
		});
		await owner.query(
			"update pix_charges set status = 'refunded', refund_shortfall = $2 where id = $1",
			[charge.id, shortfall],
		);
		return charge;
	}

	it("lists only charges with an unrecovered refund, without Asaas ids, for the superadmin and the own Bureau", async () => {
		const tenant = await seedTenant(owner, "Shortfall A");
		const other = await seedTenant(owner, "Shortfall B");
		const superadmin = await seedSuperadmin(owner);
		const short = await shortfallCharge(tenant, "30.00");
		await shortfallCharge(tenant, "0.00");
		await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		await shortfallCharge(other, "50.00");

		const asSuperadmin = await withUserTransaction(superadmin, (c) =>
			listRefundShortfalls(c, tenant.bureau.id),
		);
		const asAdmin = await withUserTransaction(tenant.bureauAdmin, (c) =>
			listRefundShortfalls(c, tenant.bureau.id),
		);

		for (const rows of [asSuperadmin, asAdmin]) {
			expect(rows).toEqual([
				{
					chargeId: short.id,
					amount: "100.00",
					shortfall: "30.00",
					createdAt: expect.any(Date),
				},
			]);
			expect(JSON.stringify(rows)).not.toContain(short.asaasPaymentId);
		}
	});

	it("hides other Bureaus from a Bureau admin and from an operator, and charges with no shortfall from the superadmin", async () => {
		const tenant = await seedTenant(owner, "Shortfall C");
		const other = await seedTenant(owner, "Shortfall D");
		const superadmin = await seedSuperadmin(owner);
		await shortfallCharge(other, "50.00");
		await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});

		expect(
			await withUserTransaction(tenant.bureauAdmin, (c) =>
				listRefundShortfalls(c, other.bureau.id),
			),
		).toEqual([]);
		expect(
			await withUserTransaction(tenant.operator, (c) =>
				listRefundShortfalls(c, other.bureau.id),
			),
		).toEqual([]);
		expect(
			await withUserTransaction(superadmin, (c) =>
				listRefundShortfalls(c, tenant.bureau.id),
			),
		).toEqual([]);
		const { rows } = await owner.query(
			"select 1 from pix_charges where bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(rows).toHaveLength(1);
	});
});

describe("getPixCharge / listPixCharges", () => {
	it("derives expired from a pending charge past its expiry and hides the Asaas id", async () => {
		const tenant = await seedTenant(owner, "Pix D");
		const admin = tenant.bureauAdmin;
		const live = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: admin.userId,
		});
		const old = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: admin.userId,
			expiresAt: new Date(Date.now() - 60_000),
		});

		const liveCharge = await withUserTransaction(admin, (c) =>
			getPixCharge(c, live.id),
		);
		const oldCharge = await withUserTransaction(admin, (c) =>
			getPixCharge(c, old.id),
		);
		const list = await withUserTransaction(admin, (c) =>
			listPixCharges(c, tenant.bureau.id),
		);

		expect(liveCharge?.status).toBe("pending");
		expect(oldCharge?.status).toBe("expired");
		expect(list.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
		expect(JSON.stringify([liveCharge, oldCharge, list])).not.toContain(
			live.asaasPaymentId,
		);
	});

	it("does not return a charge of another Bureau", async () => {
		const mine = await seedTenant(owner, "Pix E1");
		const other = await seedTenant(owner, "Pix E2");
		const charge = await seedPixCharge(owner, {
			bureauId: other.bureau.id,
			requestedBy: other.bureauAdmin.userId,
		});

		expect(
			await withUserTransaction(mine.bureauAdmin, (c) =>
				getPixCharge(c, charge.id),
			),
		).toBeNull();
	});
});

describe("POST /api/webhooks/asaas", () => {
	it("rejects a bad token with 401 and writes no event", async () => {
		const tenant = await seedTenant(owner, "Hook A");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		const eventId = evt();

		for (const token of [null, "wrong", "i".repeat(31)]) {
			expect(
				(
					await webhook(
						buildFakePaymentEvent({
							eventId,
							asaasPaymentId: charge.asaasPaymentId,
							value: 100,
						}),
						token,
					)
				).status,
			).toBe(401);
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

		const response = await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 9999,
			}),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		const { rows } = await owner.query(
			"select status from pix_charges where id = $1",
			[charge.id],
		);
		expect(rows[0].status).toBe("paid");
	});

	it("records a neutral ledger reference, never the Asaas payment id", async () => {
		const tenant = await seedTenant(owner, "Hook B2");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});

		await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
			}),
		);

		const { rows } = await owner.query<{ reference: string }>(
			"select reference from ledger_entries where bureau_id = $1 and kind = 'topup'",
			[tenant.bureau.id],
		);
		expect(rows.map((r) => r.reference)).toEqual([`pix_charge:${charge.id}`]);
		expect(rows[0].reference).not.toContain(charge.asaasPaymentId);
	});

	it("parallel duplicate events credit once", async () => {
		const tenant = await seedTenant(owner, "Hook C");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		const payload = buildFakePaymentEvent({
			eventId: evt(),
			asaasPaymentId: charge.asaasPaymentId,
			value: 100,
		});

		const responses = await Promise.all([
			webhook(payload),
			webhook(payload),
			webhook(payload),
		]);

		expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		const { rows } = await owner.query(
			"select 1 from ledger_entries where bureau_id = $1 and kind = 'topup'",
			[tenant.bureau.id],
		);
		expect(rows).toHaveLength(1);
	});

	it("paid after expiry still credits", async () => {
		const tenant = await seedTenant(owner, "Hook D");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			expiresAt: new Date(Date.now() - 3_600_000),
		});

		const response = await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
			}),
		);

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

		const response = await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
			}),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
	});

	it("answers 200 and records an unknown payment without crediting", async () => {
		const eventId = evt();

		const response = await webhook(
			buildFakePaymentEvent({
				eventId,
				asaasPaymentId: `pay_unknown_${randomUUID()}`,
				value: 100,
			}),
		);

		expect(response.status).toBe(200);
		const { rows } = await owner.query(
			"select result from asaas_webhook_events where event_id = $1",
			[eventId],
		);
		expect(rows[0].result).toBe("unknown_charge");
	});

	it("records a non-payment event as ignored without crediting", async () => {
		const tenant = await seedTenant(owner, "Hook F");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		const eventId = evt();

		const response = await webhook(
			buildFakePaymentEvent({
				eventId,
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
				event: "PAYMENT_CREATED",
			}),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		const { rows } = await owner.query(
			"select result from asaas_webhook_events where event_id = $1",
			[eventId],
		);
		expect(rows[0].result).toBe("ignored");
	});

	it("derives the event id from event and payment id when the body has none", async () => {
		const tenant = await seedTenant(owner, "Hook G");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		const body = {
			event: "PAYMENT_RECEIVED",
			payment: { object: "payment", id: charge.asaasPaymentId, value: 1 },
		};

		const responses = await Promise.all([webhook(body), webhook(body)]);

		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(await balance(tenant.bureau.id)).toBe("100.00");
		expect(await eventCount(`PAYMENT_RECEIVED:${charge.asaasPaymentId}`)).toBe(
			1,
		);
	});

	it("reverses a paid charge on PAYMENT_REFUNDED through the webhook pool", async () => {
		const tenant = await seedTenant(owner, "Hook H");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});
		await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
			}),
		);

		const response = await webhook(
			buildFakePaymentEvent({
				eventId: evt(),
				asaasPaymentId: charge.asaasPaymentId,
				value: 100,
				event: "PAYMENT_REFUNDED",
			}),
		);

		expect(response.status).toBe(200);
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		const { rows } = await owner.query(
			"select status from pix_charges where id = $1",
			[charge.id],
		);
		expect(rows[0].status).toBe("refunded");
	});

	it("stores no payload for an unknown payment", async () => {
		const eventId = evt();

		await webhook(
			buildFakePaymentEvent({
				eventId,
				asaasPaymentId: `pay_unknown_${randomUUID()}`,
				value: 100,
			}),
		);

		const { rows } = await owner.query(
			"select payload, result from asaas_webhook_events where event_id = $1",
			[eventId],
		);
		expect(rows[0]).toEqual({ payload: null, result: "unknown_charge" });
	});
});

async function clientBalance(clientProfileId: string): Promise<string> {
	const { rows } = await owner.query<{ available: string }>(
		"select available from client_wallets where client_profile_id = $1",
		[clientProfileId],
	);
	return rows[0].available;
}

// Atalhos do Pix do cliente sobre as funções atuais (reserveCharge, bindAsaasCharge, lockChargeScope).
const clientScopeOf = (clientProfileId: string) => ({ kind: "client" as const, clientProfileId });
const reserveClientPixCharge = (
	c: Parameters<typeof reserveCharge>[0],
	identity: Parameters<typeof reserveCharge>[1],
	input: { externalReference: string; amount: string },
) =>
	reserveCharge(c, identity, {
		scope: clientScopeOf(identity.userId),
		...input,
		billingType: "PIX",
		installments: 1,
		feeAmount: "0.00",
		totalCharged: null,
		payerKind: "owner",
		payerDocumentMasked: "***.456.***-**",
	});
const bindPixCharge = bindAsaasCharge;
const lockClientPixCharges = (c: Parameters<typeof lockChargeScope>[0], clientProfileId: string) =>
	lockChargeScope(c, clientScopeOf(clientProfileId));

const clientInput = (amount = "100.00") => ({ externalReference: randomUUID(), amount });
const boundInput = () => ({ asaasPaymentId: `pay_${randomUUID()}`, pixPayload: "000201clientpix" });

describe("reserveClientPixCharge", () => {
	it("stores an unbound pending charge of the client for 30 minutes and audits the request", async () => {
		const tenant = await seedTenant(owner, "Cli Pix A");
		const client = tenant.client;

		const result = await withUserTransaction(client, (c) =>
			reserveClientPixCharge(c, client, clientInput()),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { rows } = await owner.query(
			`select status, amount, client_profile_id, requested_by, bureau_id, asaas_payment_id, pix_payload,
			  round(extract(epoch from (expires_at - created_at)) / 60)::text as minutes
			 from pix_charges where id = $1`,
			[result.id],
		);
		expect(rows[0]).toMatchObject({
			status: "pending",
			minutes: "30",
			amount: "100.00",
			client_profile_id: client.userId,
			requested_by: client.userId,
			bureau_id: tenant.bureau.id,
			asaas_payment_id: null,
			pix_payload: null,
		});
		const audit = await owner.query(
			"select metadata from audit_logs where action = 'wallet.topup.request' and record_id = $1",
			[result.id],
		);
		expect(audit.rows).toHaveLength(1);
	});

	it.each(["9.99", "5000.01", "10.005", "x"])("rejects amount %s", async (amount) => {
		const tenant = await seedTenant(owner, "Cli Pix B");
		const client = tenant.client;

		const result = await withUserTransaction(client, (c) =>
			reserveClientPixCharge(c, client, clientInput(amount)),
		);

		expect(result).toEqual({ ok: false, reason: "invalid_amount" });
	});

	it("denies operator and Bureau admin at the database", async () => {
		const tenant = await seedTenant(owner, "Cli Pix C");
		for (const identity of [tenant.operator, tenant.bureauAdmin]) {
			await expect(
				withUserTransaction(identity, (c) =>
					reserveClientPixCharge(c, { ...identity, userId: tenant.client.userId }, clientInput()),
				),
			).rejects.toThrow(/row-level security/);
		}
	});

	it("denies a client that charges the wallet of another client", async () => {
		const tenant = await seedTenant(owner, "Cli Pix D");
		const other = await seedClientProfile(owner, tenant.bureau.id);

		await expect(
			withUserTransaction(tenant.client, (c) =>
				reserveClientPixCharge(c, { ...tenant.client, userId: other.userId }, clientInput()),
			),
		).rejects.toThrow(/row-level security/);
	});
});

describe("listClientPixCharges", () => {
	it("returns the effective status, shows the payload only for pending charges and hides the Asaas id", async () => {
		const tenant = await seedTenant(owner, "Cli List A");
		const client = tenant.client;
		const base = { bureauId: tenant.bureau.id, requestedBy: client.userId, clientProfileId: client.userId };
		const live = await seedPixCharge(owner, base);
		const old = await seedPixCharge(owner, { ...base, expiresAt: new Date(Date.now() - 60_000) });
		const paid = await seedPixCharge(owner, { ...base, status: "paid" });

		const list = await withUserTransaction(client, (c) => listClientPixCharges(c, client.userId));

		const byId = new Map(list.map((r) => [r.id, r]));
		expect(byId.get(live.id)).toMatchObject({ status: "pending", pixPayload: "pix-copia-e-cola-teste" });
		expect(byId.get(old.id)).toMatchObject({ status: "expired", pixPayload: null });
		expect(byId.get(paid.id)).toMatchObject({ status: "paid", pixPayload: null });
		for (const charge of [live, old, paid]) {
			expect(JSON.stringify(list)).not.toContain(charge.asaasPaymentId);
		}
	});

	it("does not let client A read the charges of client B", async () => {
		const tenant = await seedTenant(owner, "Cli List B");
		const other = await seedClientProfile(owner, tenant.bureau.id);
		await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: other.userId,
			clientProfileId: other.userId,
		});

		expect(await withUserTransaction(tenant.client, (c) => listClientPixCharges(c, other.userId))).toEqual([]);
		expect(await withUserTransaction(tenant.client, (c) => listClientPixCharges(c, tenant.client.userId))).toEqual([]);
	});
});

describe("Bureau screens never see client charges", () => {
	it("keeps client charges out of listPixCharges, getPixCharge and countPendingPixCharges", async () => {
		const tenant = await seedTenant(owner, "Cli Leak A");
		const admin = tenant.bureauAdmin;
		const bureauCharge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: admin.userId });
		const clientCharge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.client.userId,
			clientProfileId: tenant.client.userId,
		});

		const list = await withUserTransaction(admin, (c) => listPixCharges(c, tenant.bureau.id));
		const count = await withUserTransaction(admin, (c) => countPendingPixCharges(c, tenant.bureau.id));
		const direct = await withUserTransaction(admin, (c) => getPixCharge(c, clientCharge.id));

		expect(list.map((r) => r.id)).toEqual([bureauCharge.id]);
		expect(count).toBe(1);
		expect(direct).toBeNull();
	});
});

describe("countPendingClientPixCharges", () => {
	it("counts only pending, unexpired charges of that client", async () => {
		const tenant = await seedTenant(owner, "Cli Count A");
		const other = await seedClientProfile(owner, tenant.bureau.id);
		const mine = { bureauId: tenant.bureau.id, requestedBy: tenant.client.userId, clientProfileId: tenant.client.userId };
		await seedPixCharge(owner, mine);
		await seedPixCharge(owner, mine);
		await seedPixCharge(owner, { ...mine, expiresAt: new Date(Date.now() - 60_000) });
		await seedPixCharge(owner, { ...mine, status: "paid" });
		await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: other.userId, clientProfileId: other.userId });
		await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });

		expect(
			await withUserTransaction(tenant.client, (c) => countPendingClientPixCharges(c, tenant.client.userId)),
		).toBe(2);
	});

	it("keeps the cap of 10 apart from the Bureau cap", async () => {
		const tenant = await seedTenant(owner, "Cli Count B");
		for (let i = 0; i < 10; i++) {
			await seedPixCharge(owner, {
				bureauId: tenant.bureau.id,
				requestedBy: tenant.client.userId,
				clientProfileId: tenant.client.userId,
			});
		}

		expect(
			await withUserTransaction(tenant.client, (c) => countPendingClientPixCharges(c, tenant.client.userId)),
		).toBe(10);
		expect(
			await withUserTransaction(tenant.bureauAdmin, (c) => countPendingPixCharges(c, tenant.bureau.id)),
		).toBe(0);
	});
});

describe("client top-up through the webhook (fake driver)", () => {
	async function clientCharge(label: string, amount = "100.00") {
		const tenant = await seedTenant(owner, label);
		const client = tenant.client;
		const input = clientInput(amount);
		const bind = boundInput();
		const created = await withUserTransaction(client, async (c) => {
			const row = await reserveClientPixCharge(c, client, input);
			if (row.ok) await bindPixCharge(c, row.id, bind);
			return row;
		});
		if (!created.ok) throw new Error("charge not created");
		return { tenant, client, input: { ...input, ...bind }, id: created.id };
	}

	it("credits the client wallet with the local amount, leaves the Bureau wallet intact and ignores a repeated event", async () => {
		const { tenant, client, input } = await clientCharge("Cli Hook A");
		const eventId = evt();
		const event = buildFakePaymentEvent({ eventId, asaasPaymentId: input.asaasPaymentId, value: 999 });

		const first = await webhook(event);
		const second = await webhook(event);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await clientBalance(client.userId)).toBe("100.00");
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		expect(await eventCount(eventId)).toBe(1);
	});

	it("does not credit twice for a second event of the same payment", async () => {
		const { client, input } = await clientCharge("Cli Hook B");

		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: input.asaasPaymentId, value: 100 }));
		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: input.asaasPaymentId, value: 100 }));

		expect(await clientBalance(client.userId)).toBe("100.00");
	});

	it("credits a payment that arrives after the expiry", async () => {
		const tenant = await seedTenant(owner, "Cli Hook C");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.client.userId,
			clientProfileId: tenant.client.userId,
			amount: "50.00",
			expiresAt: new Date(Date.now() - 60_000),
		});

		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: charge.asaasPaymentId, value: 50 }));

		expect(await clientBalance(tenant.client.userId)).toBe("50.00");
		expect(await balance(tenant.bureau.id)).toBe("0.00");
	});
});

describe("client PIX charge reserved before Asaas (B4)", () => {
	const chargeRow = async (id: string) =>
		(
			await owner.query(
				"select status, asaas_payment_id, pix_payload, external_reference from pix_charges where id = $1",
				[id],
			)
		).rows[0];

	async function reserve(label: string) {
		const tenant = await seedTenant(owner, label);
		const input = clientInput();
		const row = await withUserTransaction(tenant.client, (c) => reserveClientPixCharge(c, tenant.client, input));
		if (!row.ok) throw new Error("charge not reserved");
		return { tenant, client: tenant.client, id: row.id, externalReference: input.externalReference };
	}

	it("binds the Asaas payment id and the PIX code once, and accepts the same id again", async () => {
		const { client, id } = await reserve("B4 Bind A");
		const bind = boundInput();

		expect(await withUserTransaction(client, (c) => bindPixCharge(c, id, bind))).toBe(true);
		expect(await withUserTransaction(client, (c) => bindPixCharge(c, id, bind))).toBe(true);
		expect(
			await withUserTransaction(client, (c) => bindPixCharge(c, id, { ...bind, asaasPaymentId: "pay_other" })),
		).toBe(false);
		expect(await chargeRow(id)).toMatchObject({
			status: "pending",
			asaas_payment_id: bind.asaasPaymentId,
			pix_payload: bind.pixPayload,
		});
	});

	it("does not bind a charge of another user or a charge that is no longer pending", async () => {
		const { tenant, client, id } = await reserve("B4 Bind B");
		const other = await seedClientProfile(owner, tenant.bureau.id);

		expect(await withUserTransaction(other, (c) => bindPixCharge(c, id, boundInput()))).toBe(false);
		expect(await withUserTransaction(tenant.bureauAdmin, (c) => bindPixCharge(c, id, boundInput()))).toBe(false);
		await withUserTransaction(client, (c) => cancelUnboundPixCharge(c, id));
		expect(await withUserTransaction(client, (c) => bindPixCharge(c, id, boundInput()))).toBe(false);
		expect((await chargeRow(id)).asaas_payment_id).toBeNull();
	});

	it("cancels an unbound charge: it leaves the cap, and it never cancels a bound or foreign charge", async () => {
		const { tenant, client, id } = await reserve("B4 Cancel");
		const other = await seedClientProfile(owner, tenant.bureau.id);
		const count = () => withUserTransaction(client, (c) => countPendingClientPixCharges(c, client.userId));
		expect(await count()).toBe(1);

		await withUserTransaction(other, (c) => cancelUnboundPixCharge(c, id));
		expect((await chargeRow(id)).status).toBe("pending");
		await withUserTransaction(client, (c) => cancelUnboundPixCharge(c, id));
		expect((await chargeRow(id)).status).toBe("cancelled");
		expect(await count()).toBe(0);

		const second = await withUserTransaction(client, (c) => reserveClientPixCharge(c, client, clientInput()));
		if (!second.ok) throw new Error("charge not reserved");
		await withUserTransaction(client, (c) => bindPixCharge(c, second.id, boundInput()));
		await withUserTransaction(client, (c) => cancelUnboundPixCharge(c, second.id));
		expect((await chargeRow(second.id)).status).toBe("pending");
	});

	it("credits through payment.externalReference when the bind never happened, and binds the payment id", async () => {
		const { tenant, client, id, externalReference } = await reserve("B4 Hook A");
		const asaasPaymentId = `pay_${randomUUID()}`;
		const event = buildFakePaymentEvent({ eventId: evt(), asaasPaymentId, value: 999, externalReference });

		expect((await webhook(event)).status).toBe(200);
		expect(await clientBalance(client.userId)).toBe("100.00");
		expect(await balance(tenant.bureau.id)).toBe("0.00");
		expect(await chargeRow(id)).toMatchObject({ status: "paid", asaas_payment_id: asaasPaymentId });
		const again = buildFakePaymentEvent({ eventId: evt(), asaasPaymentId, value: 100, externalReference });
		await webhook(again);
		expect(await clientBalance(client.userId)).toBe("100.00");
	});

	it("does not credit a payment whose externalReference matches a charge bound to another payment", async () => {
		const { client, id, externalReference } = await reserve("B4 Hook B");
		await withUserTransaction(client, (c) => bindPixCharge(c, id, boundInput()));
		const eventId = evt();

		await webhook(buildFakePaymentEvent({ eventId, asaasPaymentId: "pay_intruder", value: 100, externalReference }));

		expect(await clientBalance(client.userId)).toBe("0.00");
		const { rows } = await owner.query("select result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(rows[0].result).toBe("unknown_charge");
	});

	it("ignores a malformed externalReference", async () => {
		const { client } = await reserve("B4 Hook C");
		const eventId = evt();

		await webhook(
			buildFakePaymentEvent({ eventId, asaasPaymentId: "pay_x", value: 100, externalReference: "not-a-uuid" }),
		);

		expect(await clientBalance(client.userId)).toBe("0.00");
		const { rows } = await owner.query("select result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(rows[0].result).toBe("unknown_charge");
	});

	it("ignores a payment on a cancelled unbound charge", async () => {
		const { client, id, externalReference } = await reserve("B4 Hook D");
		await withUserTransaction(client, (c) => cancelUnboundPixCharge(c, id));

		await webhook(buildFakePaymentEvent({ eventId: evt(), asaasPaymentId: "pay_c", value: 100, externalReference }));

		expect(await clientBalance(client.userId)).toBe("0.00");
	});

	it("keeps the cap under parallel reservations: only the slot left is taken", async () => {
		const tenant = await seedTenant(owner, "B4 Cap");
		const client = tenant.client;
		for (let i = 0; i < 9; i++) {
			await seedPixCharge(owner, {
				bureauId: tenant.bureau.id,
				requestedBy: client.userId,
				clientProfileId: client.userId,
			});
		}
		const attempt = () =>
			withUserTransaction(client, async (c) => {
				await lockClientPixCharges(c, client.userId);
				if ((await countPendingClientPixCharges(c, client.userId)) >= 10) return null;
				return reserveClientPixCharge(c, client, clientInput());
			});

		const results = await Promise.all([attempt(), attempt()]);

		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await withUserTransaction(client, (c) => countPendingClientPixCharges(c, client.userId))).toBe(10);
	});
});

describe("reserveCharge (Pix and card, both scopes)", () => {
	const reserveInput = (scope: ReserveChargeInput["scope"], overrides: Partial<ReserveChargeInput> = {}): ReserveChargeInput => ({
		scope,
		externalReference: randomUUID(),
		amount: "100.00",
		billingType: "PIX",
		installments: 1,
		feeAmount: "0.00",
		totalCharged: null,
		payerKind: "owner",
		payerDocumentMasked: "***.456.***-**",
		...overrides,
	});
	const cardInput = (scope: ReserveChargeInput["scope"], overrides: Partial<ReserveChargeInput> = {}) =>
		reserveInput(scope, {
			billingType: "CREDIT_CARD",
			installments: 3,
			feeAmount: "6.50",
			totalCharged: "106.50",
			...overrides,
		});
	const row = async (id: string) =>
		(await owner.query("select * from pix_charges where id = $1", [id])).rows[0];

	it("reserves a client card charge with the card columns and audits only masked data", async () => {
		const tenant = await seedTenant(owner, "Rsv A");
		const client = tenant.client;
		const input = cardInput({ kind: "client", clientProfileId: client.userId });

		const result = await withUserTransaction(client, (c) => reserveCharge(c, client, input));

		expect(result).toMatchObject({ ok: true, reused: false });
		if (!result.ok) return;
		expect(await row(result.id)).toMatchObject({
			status: "pending",
			client_profile_id: client.userId,
			requested_by: client.userId,
			billing_type: "CREDIT_CARD",
			installments: 3,
			fee_amount: "6.50",
			total_charged: "106.50",
			amount: "100.00",
			payer_kind: "owner",
			payer_document_masked: "***.456.***-**",
			asaas_payment_id: null,
			asaas_customer_id: null,
		});
		const audit = await owner.query(
			"select metadata from audit_logs where action = 'wallet.topup.request' and record_id = $1",
			[result.id],
		);
		expect(audit.rows[0].metadata).toEqual({
			amount: "100.00",
			billingType: "CREDIT_CARD",
			installments: 3,
			payerKind: "owner",
			payerMask: "***.456.***-**",
		});
	});

	it("reserves a Bureau Pix charge (no client) for the bureau_admin and denies operator and client", async () => {
		const tenant = await seedTenant(owner, "Rsv B");
		const admin = tenant.bureauAdmin;
		const input = reserveInput({ kind: "bureau", bureauId: tenant.bureau.id }, { payerKind: "other" });

		const result = await withUserTransaction(admin, (c) => reserveCharge(c, admin, input));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await row(result.id)).toMatchObject({
			client_profile_id: null,
			requested_by: admin.userId,
			billing_type: "PIX",
			installments: 1,
			total_charged: null,
		});
		for (const identity of [tenant.operator, tenant.client]) {
			await expect(
				withUserTransaction(identity, (c) =>
					reserveCharge(c, identity, reserveInput({ kind: "bureau", bureauId: tenant.bureau.id })),
				),
			).rejects.toThrow(/row-level security/);
		}
	});

	it("returns the same row for the same reference and author, without a second audit", async () => {
		const tenant = await seedTenant(owner, "Rsv C");
		const client = tenant.client;
		const input = reserveInput({ kind: "client", clientProfileId: client.userId });

		const first = await withUserTransaction(client, (c) => reserveCharge(c, client, input));
		const second = await withUserTransaction(client, (c) => reserveCharge(c, client, input));

		expect(first).toMatchObject({ ok: true, reused: false });
		expect(second).toMatchObject({ ok: true, reused: true });
		if (!first.ok || !second.ok) return;
		expect(second.id).toBe(first.id);
		const audit = await owner.query("select 1 from audit_logs where action = 'wallet.topup.request' and record_id = $1", [first.id]);
		expect(audit.rows).toHaveLength(1);
	});

	it("returns reference_taken for another client of the same Bureau and for another tenant", async () => {
		const tenant = await seedTenant(owner, "Rsv D");
		const other = await seedTenant(owner, "Rsv D2");
		const first = tenant.client;
		const sameBureau = await seedClientProfile(owner, tenant.bureau.id);
		const input = reserveInput({ kind: "client", clientProfileId: first.userId });
		await withUserTransaction(first, (c) => reserveCharge(c, first, input));

		const sameBureauResult = await withUserTransaction(sameBureau, (c) =>
			reserveCharge(c, sameBureau, { ...input, scope: { kind: "client", clientProfileId: sameBureau.userId } }),
		);
		const otherTenantResult = await withUserTransaction(other.bureauAdmin, (c) =>
			reserveCharge(c, other.bureauAdmin, { ...input, scope: { kind: "bureau", bureauId: other.bureau.id } }),
		);

		expect(sameBureauResult).toEqual({ ok: false, reason: "reference_taken" });
		expect(otherTenantResult).toEqual({ ok: false, reason: "reference_taken" });
	});

	it("rejects an invalid amount and a Pix row that carries card data", async () => {
		const tenant = await seedTenant(owner, "Rsv E");
		const client = tenant.client;
		const scope = { kind: "client", clientProfileId: client.userId } as const;

		expect(await withUserTransaction(client, (c) => reserveCharge(c, client, reserveInput(scope, { amount: "9.99" })))).toEqual({
			ok: false,
			reason: "invalid_amount",
		});
		await expect(
			withUserTransaction(client, (c) => reserveCharge(c, client, reserveInput(scope, { installments: 2 }))),
		).rejects.toThrow(/pix_charges_billing_shape_check/);
		await expect(
			withUserTransaction(client, (c) =>
				reserveCharge(c, client, cardInput(scope, { totalCharged: "107.00" })),
			),
		).rejects.toThrow(/pix_charges_billing_shape_check/);
	});

	it("check refuses a payer_document_masked with 11 digits", async () => {
		const tenant = await seedTenant(owner, "Rsv F");
		const client = tenant.client;

		await expect(
			withUserTransaction(client, (c) =>
				reserveCharge(c, client, reserveInput({ kind: "client", clientProfileId: client.userId }, { payerDocumentMasked: "12345678909" })),
			),
		).rejects.toThrow(/payer_document_masked/);
	});

	it("serializes the scope lock and counts card attempts of the last hour for the author only", async () => {
		const tenant = await seedTenant(owner, "Rsv G");
		const client = tenant.client;
		const scope = { kind: "client", clientProfileId: client.userId } as const;
		for (let i = 0; i < 2; i++) {
			await withUserTransaction(client, (c) => reserveCharge(c, client, cardInput(scope)));
		}
		await withUserTransaction(client, (c) => reserveCharge(c, client, reserveInput(scope)));
		const old = await withUserTransaction(client, (c) => reserveCharge(c, client, cardInput(scope)));
		if (!old.ok) throw new Error("not reserved");
		await owner.query("update pix_charges set created_at = now() - interval '2 hours' where id = $1", [old.id]);
		const otherClient = await seedClientProfile(owner, tenant.bureau.id);
		await withUserTransaction(otherClient, (c) =>
			reserveCharge(c, otherClient, cardInput({ kind: "client", clientProfileId: otherClient.userId })),
		);

		const total = await withUserTransaction(client, async (c) => {
			await lockChargeScope(c, scope);
			return countRecentCardAttempts(c, client.userId);
		});

		expect(total).toBe(2);
	});

	it("sets the Asaas customer once, idempotently, only for the author", async () => {
		const tenant = await seedTenant(owner, "Rsv H");
		const client = tenant.client;
		const created = await withUserTransaction(client, (c) =>
			reserveCharge(c, client, reserveInput({ kind: "client", clientProfileId: client.userId })),
		);
		if (!created.ok) throw new Error("not reserved");

		await withUserTransaction(client, (c) => setChargeCustomer(c, created.id, "cus_1"));
		await withUserTransaction(client, (c) => setChargeCustomer(c, created.id, "cus_1"));
		await expect(withUserTransaction(client, (c) => setChargeCustomer(c, created.id, "cus_2"))).rejects.toThrow(
			/cliente Asaas/,
		);
		const other = await seedClientProfile(owner, tenant.bureau.id);
		await expect(withUserTransaction(other, (c) => setChargeCustomer(c, created.id, "cus_1"))).rejects.toThrow(/cliente Asaas/);

		expect((await row(created.id)).asaas_customer_id).toBe("cus_1");
	});

	it("binds card data and the installment id, and reports the effective status", async () => {
		const tenant = await seedTenant(owner, "Rsv I");
		const client = tenant.client;
		const created = await withUserTransaction(client, (c) =>
			reserveCharge(c, client, cardInput({ kind: "client", clientProfileId: client.userId })),
		);
		if (!created.ok) throw new Error("not reserved");
		const p1 = `pay_${randomUUID()}`;
		const ins = `ins_${randomUUID()}`;

		const bound = await withUserTransaction(client, (c) =>
			bindAsaasCharge(c, created.id, {
				asaasPaymentId: p1,
				asaasInstallmentId: ins,
				cardBrand: "VISA",
				cardLast4: "4242",
			}),
		);
		const sameAgain = await withUserTransaction(client, (c) =>
			bindAsaasCharge(c, created.id, { asaasPaymentId: p1, asaasInstallmentId: ins }),
		);
		const otherPayment = await withUserTransaction(client, (c) =>
			bindAsaasCharge(c, created.id, { asaasPaymentId: `pay_${randomUUID()}` }),
		);

		expect([bound, sameAgain, otherPayment]).toEqual([true, true, false]);
		expect(await row(created.id)).toMatchObject({
			asaas_payment_id: p1,
			asaas_installment_id: ins,
			card_brand: "VISA",
			card_last4: "4242",
			pix_payload: null,
		});
		expect(await withUserTransaction(client, (c) => getChargeStatus(c, created.id, clientScopeOf(client.userId)))).toEqual({
			status: "pending",
			billingType: "CREDIT_CARD",
		});
		await owner.query("update pix_charges set expires_at = now() - interval '1 minute' where id = $1", [created.id]);
		expect((await withUserTransaction(client, (c) => getChargeStatus(c, created.id, clientScopeOf(client.userId))))?.status).toBe("expired");
	});

	it("reports the status only to the owner scope: not to another client, nor to the Bureau scope", async () => {
		const tenant = await seedTenant(owner, "Rsv Status");
		const client = tenant.client;
		const other = await seedClientProfile(owner, tenant.bureau.id);
		const created = await withUserTransaction(client, (c) =>
			reserveCharge(c, client, cardInput({ kind: "client", clientProfileId: client.userId })),
		);
		if (!created.ok) throw new Error("not reserved");

		const asOther = await withUserTransaction(other, (c) =>
			getChargeStatus(c, created.id, clientScopeOf(other.userId)),
		);
		const asBureau = await withUserTransaction(tenant.bureauAdmin, (c) =>
			getChargeStatus(c, created.id, { kind: "bureau", bureauId: tenant.bureau.id }),
		);

		expect([asOther, asBureau]).toEqual([null, null]);
	});

	it("keeps the 3-argument bind working for Pix and refuses a Pix bind without a payload", async () => {
		const tenant = await seedTenant(owner, "Rsv J");
		const client = tenant.client;
		const created = await withUserTransaction(client, (c) =>
			reserveCharge(c, client, reserveInput({ kind: "client", clientProfileId: client.userId })),
		);
		if (!created.ok) throw new Error("not reserved");
		const pixPay = `pay_${randomUUID()}`;

		const withoutPayload = await withUserTransaction(client, (c) =>
			bindAsaasCharge(c, created.id, { asaasPaymentId: pixPay }),
		);
		const legacy = await withUserTransaction(client, (c) =>
			bindPixCharge(c, created.id, { asaasPaymentId: pixPay, pixPayload: "000201x" }),
		);

		expect([withoutPayload, legacy]).toEqual([false, true]);
		expect(await row(created.id)).toMatchObject({ asaas_payment_id: pixPay, pix_payload: "000201x" });
	});
});
