// Pagamento de balcão contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { reserveOrder } from "@/lib/settlement/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedDossier, seedOrderCatalog, seedOrderDossier, seedTenant, seedWalletTopup } from "@/test/seed";

import { listCounterPayments, registerCounterPayment, voidCounterPayment } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

async function setup(label: string) {
	const tenant = await seedTenant(owner, label);
	const dossierId = await seedDossier(owner, {
		bureauId: tenant.bureau.id,
		holderId: tenant.holder.id,
		createdBy: tenant.bureauAdmin.userId,
	});
	// reserve_order exige o pedido (dossier_orders) do Dossiê.
	await seedOrderDossier(owner, { orderRef: dossierId, bureauId: tenant.bureau.id, clientProfileId: null });
	const operator: DbIdentity = { ...tenant.operator };
	const admin: DbIdentity = { ...tenant.bureauAdmin };
	const client: DbIdentity = { ...tenant.client };
	return { tenant, dossierId, operator, admin, client };
}

const pay = (dossierId: string, amount: string, extra: { note?: string | null } = {}) => ({
	dossierId,
	method: "cash" as const,
	amount,
	note: extra.note ?? null,
	receivedAt: new Date("2026-10-14T12:00:00Z"),
});

async function auditRows(paymentId: string, action: string) {
	const { rows } = await owner.query<{ metadata: Record<string, unknown>; user_id: string }>(
		"select metadata, user_id from audit_logs where record_id = $1 and action = $2",
		[paymentId, action],
	);
	return rows;
}

describe("registerCounterPayment", () => {
	it("lets the operator register a payment and audits it without sensitive data", async () => {
		const { tenant, dossierId, operator } = await setup("Counter R1");

		const result = await registerCounterPayment(operator, pay(dossierId, "25.50", { note: "troco 5" }));
		expect(result).toMatchObject({ ok: true });
		const id = (result as { id: string }).id;

		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));
		expect(listed.payments).toHaveLength(1);
		expect(listed.payments[0]).toMatchObject({
			id,
			method: "cash",
			amount: "25.50",
			note: "troco 5",
			registeredBy: operator.userId,
			voidedAt: null,
		});

		const rows = await auditRows(id, "counter.register");
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe(operator.userId);
		expect(rows[0].metadata).toMatchObject({ dossier_id: dossierId, method: "cash", amount: "25.50" });
		const raw = JSON.stringify(rows);
		expect(raw).not.toContain(tenant.holder.document);
		expect(raw).not.toContain("troco");
	});

	it("returns not_found for a dossier of another Bureau", async () => {
		const { operator } = await setup("Counter R2");
		const other = await setup("Counter R2b");
		expect(await registerCounterPayment(operator, pay(other.dossierId, "10.00"))).toEqual({ ok: false, reason: "not_found" });
		expect(await registerCounterPayment(operator, pay(randomUUID(), "10.00"))).toEqual({ ok: false, reason: "not_found" });
	});

	it("refuses a Dossiê settled online (the client pays it from the wallet) and writes nothing", async () => {
		const { tenant, dossierId, operator } = await setup("Counter R5");
		const clientId = tenant.client.userId;
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost)
			 values ($1, $2, 'online', $3, 50.00, 10.00)`,
			[dossierId, tenant.bureau.id, clientId],
		);

		expect(await registerCounterPayment(operator, pay(dossierId, "50.00"))).toEqual({
			ok: false,
			reason: "online_settlement",
		});
		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));
		expect(listed.payments).toEqual([]);
	});

	it("rejects a client", async () => {
		const { dossierId, client } = await setup("Counter R3");
		await expect(registerCounterPayment(client, pay(dossierId, "10.00"))).rejects.toThrow();
	});

	it("does not touch any wallet", async () => {
		const { tenant, dossierId, operator } = await setup("Counter R4");
		await seedWalletTopup(owner, { bureauId: tenant.bureau.id, amount: "100.00", createdBy: tenant.bureauAdmin.userId });
		await registerCounterPayment(operator, pay(dossierId, "30.00"));
		const { rows } = await owner.query("select available, reserved from wallets where bureau_id = $1", [tenant.bureau.id]);
		expect(rows).toEqual([{ available: "100.00", reserved: "0.00" }]);
	});
});

describe("paidTotal", () => {
	it("sums in SQL: two payments of 60 million do not throw a RangeError", async () => {
		const { dossierId, operator } = await setup("Counter T1");
		await registerCounterPayment(operator, pay(dossierId, "60000000.00"));
		await registerCounterPayment(operator, pay(dossierId, "60000000.01"));

		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));

		expect(listed.paidTotal).toBe("120000000.01");
	});
});

describe("voidCounterPayment", () => {
	it("requires a reason, voids once and audits it", async () => {
		const { dossierId, operator } = await setup("Counter V1");
		const created = (await registerCounterPayment(operator, pay(dossierId, "40.00"))) as { id: string };

		expect(await voidCounterPayment(operator, { id: created.id, reason: "   " })).toEqual({ ok: false, reason: "reason_required" });
		expect(await voidCounterPayment(operator, { id: created.id, reason: "Valor digitado errado" })).toEqual({ ok: true });
		expect(await voidCounterPayment(operator, { id: created.id, reason: "De novo" })).toEqual({ ok: false, reason: "already_voided" });

		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));
		expect(listed.payments[0]).toMatchObject({ voidedBy: operator.userId, voidReason: "Valor digitado errado" });
		expect(listed.payments[0].voidedAt).toBeInstanceOf(Date);

		const rows = await auditRows(created.id, "counter.void");
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject({ dossier_id: dossierId, amount: "40.00" });
		expect(JSON.stringify(rows)).not.toContain("digitado");
	});

	it("returns not_found for a payment of another Bureau and rejects a client", async () => {
		const a = await setup("Counter V2");
		const b = await setup("Counter V2b");
		const created = (await registerCounterPayment(a.operator, pay(a.dossierId, "10.00"))) as { id: string };

		expect(await voidCounterPayment(b.operator, { id: created.id, reason: "x" })).toEqual({ ok: false, reason: "not_found" });
		expect(await voidCounterPayment(a.client, { id: created.id, reason: "x" })).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("listCounterPayments", () => {
	it("sums partial payments in cents and ignores voided ones", async () => {
		const { dossierId, operator } = await setup("Counter L1");
		await registerCounterPayment(operator, pay(dossierId, "0.10"));
		await registerCounterPayment(operator, pay(dossierId, "0.20"));
		const voided = (await registerCounterPayment(operator, pay(dossierId, "99.99"))) as { id: string };
		await voidCounterPayment(operator, { id: voided.id, reason: "Lançado por engano" });

		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));
		expect(listed.payments).toHaveLength(3);
		expect(listed.paidTotal).toBe("0.30");
		expect(listed.price).toBeNull();
	});

	it("compares against the settlement price when there is one", async () => {
		const { tenant, dossierId, operator } = await setup("Counter L2");
		await seedWalletTopup(owner, { bureauId: tenant.bureau.id, amount: "100.00", createdBy: tenant.bureauAdmin.userId });
		await withUserTransaction(operator, async (c) => {
			// reserve_order confere preço e custo no catálogo do Bureau.
			const { lines } = await seedOrderCatalog(owner, c, { price: "50.00", cost: "30.00" });
			return reserveOrder(c, {
				orderRef: dossierId,
				mode: "counter",
				clientProfileId: null,
				quote: {
					ok: true,
					lines: [{ productVersionId: randomUUID(), code: lines[0].code, costCents: 3000, priceCents: 5000 }],
					totalCostCents: 3000,
					totalPriceCents: 5000,
				},
			});
		});
		await registerCounterPayment(operator, pay(dossierId, "20.00"));

		const listed = await withUserTransaction(operator, (c) => listCounterPayments(c, dossierId));
		expect(listed).toMatchObject({ paidTotal: "20.00", price: "50.00" });
	});

	it("does not list payments of another Bureau", async () => {
		const a = await setup("Counter L3");
		const b = await setup("Counter L3b");
		await registerCounterPayment(a.operator, pay(a.dossierId, "10.00"));
		const listed = await withUserTransaction(b.operator, (c) => listCounterPayments(c, a.dossierId));
		expect(listed.payments).toHaveLength(0);
		expect(listed.paidTotal).toBe("0.00");
	});
});
