// placeOrder online: saldo cobre o preço (reserva direta) ou não cobre (pedido aguarda o PIX com preço e cupom guardados),
// e getOrderPayment. Contra um Postgres real, sob RLS. Preço de venda 50,00 e custo 1,00 (dossie_pf).
import { randomBytes } from "node:crypto";

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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedBureauCost, seedCatalogItem, seedClientProfile, seedClientWalletTopup, seedTenant, seedWalletTopup, type SeededTenant } from "@/test/seed";

import { getOrderPayment } from "./order-pix";
import { placeOrder } from "./queries";
import type { OpenOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const input: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

async function newTenant(
	label: string,
	funds: { client?: string; bureau?: string } = { client: "10.00", bureau: "200.00" },
	salePrice = "50.00",
) {
	const t = await seedTenant(owner, label);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await seedCatalogItem(owner, {
		bureauId: t.bureau.id,
		productId: rows[0].id,
		salePrice,
		salePricePerPartner: "0.00",
		updatedBy: t.bureauAdmin.userId,
	});
	if (funds.client) await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: funds.client, createdBy: t.bureauAdmin.userId });
	if (funds.bureau) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: funds.bureau, createdBy: t.bureauAdmin.userId });
	return t;
}

async function seedCoupon(t: SeededTenant, i: { kind?: "percent" | "fixed"; value: string; maxUses?: number }): Promise<string> {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, valid_from, active, created_by)
		 values ($1, $2, $3, $4, true, $5, now() - interval '1 hour', true, $6)`,
		[t.bureau.id, code, i.kind ?? "percent", i.value, i.maxUses ?? null, t.bureauAdmin.userId],
	);
	return code;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });
const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

// O cliente não lê o custo do catálogo: a cotação sai com a identidade da equipe, como nos outros testes de pedido.
async function quote(t: SeededTenant) {
	const q = await quoteOrder(staff(t), "dossie_pf", { partnerCount: 0 });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}
const count = async (table: string, t: SeededTenant) =>
	Number((await rows<{ n: string }>(`select count(*) as n from ${table} where bureau_id = $1`, [t.bureau.id]))[0].n);
const ledgerEntries = async (t: SeededTenant) =>
	Number((await rows<{ n: string }>("select count(*) as n from client_ledger_entries where client_profile_id = $1", [t.client.userId]))[0].n);
const slots = async (t: SeededTenant) =>
	Number((await rows<{ n: string }>("select count(*) as n from coupon_attempt_misses where profile_id = $1", [t.client.userId]))[0].n);
const stateOf = async (id: string) =>
	(await rows<{ state: string }>("select state from dossier_orders where dossier_id = $1", [id]))[0].state;

async function nothingSaved(t: SeededTenant) {
	for (const table of ["dossiers", "dossier_orders", "scr_authorizations", "order_pix_quotes", "order_settlements"]) {
		expect(await count(table, t), table).toBe(0);
	}
}

describe("placeOrder: balance or PIX", () => {
	it("balance that covers the price reserves at once", async () => {
		const t = await newTenant("opx cover", { client: "200.00", bureau: "200.00" });

		const placed = await placeOrder(buyerOf(t), input, await quote(t));

		expect(placed).toMatchObject({ ok: true, state: "awaiting_authorization" });
		expect(placed).not.toHaveProperty("pixPriceCents");
		expect((await rows("select status from order_settlements where bureau_id = $1", [t.bureau.id]))).toEqual([{ status: "reserved" }]);
		expect(await count("order_pix_quotes", t)).toBe(0);
	});

	it("low balance opens the order awaiting payment", async () => {
		const t = await newTenant("opx low");
		const code = await seedCoupon(t, { kind: "fixed", value: "5" });
		const before = await ledgerEntries(t);

		const placed = await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code });

		expect(placed).toMatchObject({ ok: true, state: "awaiting_payment", pixPriceCents: 4500 });
		if (!placed.ok) return;
		expect(await stateOf(placed.dossierId)).toBe("awaiting_payment");
		expect(await rows("select price, coupon_code from order_pix_quotes where dossier_id = $1", [placed.dossierId])).toEqual([
			{ price: "45.00", coupon_code: code },
		]);
		expect(await count("order_settlements", t)).toBe(0);
		expect(await count("coupon_redemptions", t)).toBe(0);
		expect(await ledgerEntries(t)).toBe(before);
		expect(await slots(t)).toBe(0);
	});

	it("low balance without coupon stores the full price and a null coupon", async () => {
		const t = await newTenant("opx nocoupon");

		const placed = await placeOrder(buyerOf(t), input, await quote(t));

		expect(placed).toMatchObject({ ok: true, state: "awaiting_payment", pixPriceCents: 5000 });
		expect(await rows("select price, coupon_code from order_pix_quotes where bureau_id = $1", [t.bureau.id])).toEqual([
			{ price: "50.00", coupon_code: null },
		]);
	});

	it("zero price with a 100% coupon skips the PIX", async () => {
		const t = await newTenant("opx zero", { bureau: "200.00" });
		const code = await seedCoupon(t, { value: "100" });

		const placed = await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code });

		expect(placed).toMatchObject({ ok: true });
		expect(placed).not.toHaveProperty("pixPriceCents");
		if (!placed.ok) return;
		expect(placed.state).not.toBe("awaiting_payment");
		expect(await stateOf(placed.dossierId)).not.toBe("awaiting_payment");
		expect(await count("order_pix_quotes", t)).toBe(0);
	});

	it("price above the PIX limit is refused and leaves nothing", async () => {
		const t = await newTenant("opx above", { client: "10.00", bureau: "200.00" }, "6000.00");

		try {
			expect(await placeOrder(buyerOf(t), input, await quote(t))).toEqual({ ok: false, reason: "pix_amount_above_limit" });
			await nothingSaved(t);
		} finally {
			// O preço do produto é global: devolve os 50,00 que os outros arquivos esperam.
			await newTenant("opx above restore", { bureau: "1.00" });
		}
	});

	it("price below the PIX minimum is refused and gives the coupon slot back", async () => {
		const t = await newTenant("opx below", { client: "2.00", bureau: "200.00" });
		const code = await seedCoupon(t, { kind: "fixed", value: "45" });

		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toEqual({
			ok: false,
			reason: "pix_amount_below_minimum",
		});
		await nothingSaved(t);
		expect(await slots(t)).toBe(0);
	});

	it("exhausted coupon at opening is refused before the PIX (preview already hides it as coupon_invalid)", async () => {
		const t = await newTenant("opx exhausted");
		const code = await seedCoupon(t, { value: "100", maxUses: 1 });
		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toMatchObject({ ok: true });
		const orders = await count("dossier_orders", t);

		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toEqual({ ok: false, reason: "coupon_invalid" });
		expect(await count("dossier_orders", t)).toBe(orders);
		expect(await count("order_pix_quotes", t)).toBe(0);
	});
});

describe("getOrderPayment", () => {
	it("returns the order, the quote and no charge before the PIX is created", async () => {
		const t = await newTenant("opx get");
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		if (!placed.ok) throw new Error("placeOrder failed");

		const payment = await withUserTransaction(buyerOf(t), (c) => getOrderPayment(c, placed.dossierId));

		expect(payment).toEqual({ state: "awaiting_payment", priceCents: 5000, couponCode: null, charge: null });
	});

	it("returns null for another client's order", async () => {
		const t = await newTenant("opx other");
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		if (!placed.ok) throw new Error("placeOrder failed");
		const stranger = await seedClientProfile(owner, t.bureau.id);

		expect(await withUserTransaction(stranger, (c) => getOrderPayment(c, placed.dossierId))).toBeNull();
	});

	it("reports a pending charge past expires_at as expired without payload", async () => {
		const t = await newTenant("opx expired");
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		if (!placed.ok) throw new Error("placeOrder failed");
		await owner.query(
			`insert into pix_charges (bureau_id, asaas_payment_id, amount, fee_amount, total_charged, status, pix_payload, expires_at, requested_by, client_profile_id, order_id, billing_type)
			 values ($1, $2, 50.00, 0.99, 50.99, 'pending', 'pix-copia-e-cola-teste', now() - interval '1 minute', $3, $3, $4, 'PIX')`,
			[t.bureau.id, `pay_${randomBytes(8).toString("hex")}`, t.client.userId, placed.dossierId],
		);

		const payment = await withUserTransaction(buyerOf(t), (c) => getOrderPayment(c, placed.dossierId));

		expect(payment?.charge).toMatchObject({ status: "expired", pixPayload: null, amountCents: 5000, feeCents: 99, totalCents: 5099 });
	});

	it("returns the payload of a live pending charge", async () => {
		const t = await newTenant("opx live");
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		if (!placed.ok) throw new Error("placeOrder failed");
		await owner.query(
			`insert into pix_charges (bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by, client_profile_id, order_id, billing_type)
			 values ($1, $2, 50.00, 'pending', 'pix-copia-e-cola-teste', now() + interval '30 minutes', $3, $3, $4, 'PIX')`,
			[t.bureau.id, `pay_${randomBytes(8).toString("hex")}`, t.client.userId, placed.dossierId],
		);

		const payment = await withUserTransaction(buyerOf(t), (c) => getOrderPayment(c, placed.dossierId));

		expect(payment?.charge).toMatchObject({ status: "pending", pixPayload: "pix-copia-e-cola-teste", totalCents: 5000, feeCents: 0 });
	});
});
