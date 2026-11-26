// Esquema do PIX do pedido (063): order_pix_quotes, pix_charges.order_id e o ramo online de refresh_order_state.
// Contra um Postgres real, sob RLS. Preço de venda 50,00 e custo 1,00 (dossie_pf).
import { randomBytes, randomUUID } from "node:crypto";

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
import { reserveOrder } from "@/lib/settlement/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedBureauCost, seedCatalogItem, seedClientProfile, seedClientWalletTopup, seedTenant, seedWalletTopup, withDbContext, type SeededTenant } from "@/test/seed";

import { countPendingClientPixCharges, listClientPixCharges } from "@/lib/wallet/pix-charges";

import { openOrder, placeOrder, refreshOrderState } from "./queries";
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

async function newTenant(label: string, funds: { client?: string; bureau?: string } = { bureau: "200.00" }) {
	const t = await seedTenant(owner, label);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await seedCatalogItem(owner, {
		bureauId: t.bureau.id,
		productId: rows[0].id,
		salePrice: "50.00",
		salePricePerPartner: "0.00",
		updatedBy: t.bureauAdmin.userId,
	});
	if (funds.client) await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: funds.client, createdBy: t.bureauAdmin.userId });
	if (funds.bureau) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: funds.bureau, createdBy: t.bureauAdmin.userId });
	return t;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });
const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });
const clientCtx = (id: DbIdentity) => ({ userId: id.userId, role: id.role, bureauId: id.bureauId });

async function quote(t: SeededTenant) {
	const q = await quoteOrder(staff(t), "dossie_pf", { partnerCount: 0 });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

async function stateOf(dossierId: string): Promise<string> {
	const { rows } = await owner.query<{ state: string }>("select state from dossier_orders where dossier_id = $1", [dossierId]);
	return rows[0].state;
}

// Abre um pedido online sem reservar (como o fluxo por PIX faz).
async function openOnlineOrder(identity: DbIdentity): Promise<string> {
	return withUserTransaction(identity, async (client) => {
		const opened = await openOrder(client, input);
		if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
		return opened.dossierId;
	});
}

// Cotação do pedido gravada pelo dono (a política de insert do cliente é testada à parte).
async function seedQuote(t: SeededTenant, dossierId: string, price = "50.00"): Promise<void> {
	await owner.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price) values ($1, $2, $3, $4)", [
		dossierId,
		t.bureau.id,
		t.client.userId,
		price,
	]);
}

const insertQuote = (id: DbIdentity, dossierId: string, price = "50.00") => (c: import("pg").PoolClient) =>
	c.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price) values ($1, $2, $3, $4)", [
		dossierId,
		id.bureauId,
		id.userId,
		price,
	]);

const chargeSql = `insert into pix_charges (bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by, client_profile_id, order_id, billing_type)
	values ($1, $2, $3, $4, 'pix-copia-e-cola-teste', now() + interval '30 minutes', $5, $5, $6, $7)`;
const newPaymentId = () => `pay_${randomBytes(8).toString("hex")}`;

// Insert do app (reserveCharge): só as colunas que app_runtime pode gravar; a referência externa é a chave.
const insertCharge = (id: DbIdentity, dossierId: string, amount: string) => (c: import("pg").PoolClient) =>
	c.query(
		`insert into pix_charges (bureau_id, external_reference, amount, expires_at, requested_by, client_profile_id, order_id)
		 values ($1, $2, $3, now() + interval '30 minutes', $4, $4, $5)`,
		[id.bureauId, randomUUID(), amount, id.userId, dossierId],
	);

async function ownerCharge(t: SeededTenant, dossierId: string, status: "pending" | "paid" | "cancelled"): Promise<string> {
	const paymentId = newPaymentId();
	await owner.query(chargeSql, [t.bureau.id, paymentId, "50.00", status, t.client.userId, dossierId, "PIX"]);
	return paymentId;
}

describe("order PIX schema", () => {
	it("open_order online without settlement lands in awaiting_payment", async () => {
		const t = await newTenant("ops open");
		const dossierId = await openOnlineOrder(buyerOf(t));
		expect(await stateOf(dossierId)).toBe("awaiting_payment");
	});

	it("refresh moves a paid online order out of awaiting_payment", async () => {
		const t = await newTenant("ops paid", { client: "200.00", bureau: "200.00" });
		const dossierId = await openOnlineOrder(buyerOf(t));
		expect(await stateOf(dossierId)).toBe("awaiting_payment");

		const q = await quote(t);
		await withUserTransaction(buyerOf(t), async (client) => {
			const reserved = await reserveOrder(client, { orderRef: dossierId, mode: "online", clientProfileId: t.client.userId, quote: q });
			expect(reserved.ok).toBe(true);
		});
		// O cliente não atualiza o pedido: quem chama refresh_order_state é a equipe (ou o tick e o webhook).
		expect(await withUserTransaction(staff(t), (client) => refreshOrderState(client, dossierId))).toBe("awaiting_authorization");
		expect(await stateOf(dossierId)).toBe("awaiting_authorization");
	});

	it("refresh keeps an online order with a reserved settlement", async () => {
		const t = await newTenant("ops keep", { client: "200.00", bureau: "200.00" });
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		expect(placed).toMatchObject({ ok: true });
		if (!placed.ok) return;

		const state = await withUserTransaction(staff(t), (client) => refreshOrderState(client, placed.dossierId));
		expect(state).toBe("awaiting_authorization");
		expect(await stateOf(placed.dossierId)).toBe("awaiting_authorization");
	});

	it("client inserts a quote only for an own online order awaiting payment", async () => {
		const t = await newTenant("ops quote", { client: "200.00", bureau: "200.00" });
		const other = await seedClientProfile(owner, t.bureau.id);
		const awaiting = await openOnlineOrder(buyerOf(t));
		const placed = await placeOrder(buyerOf(t), input, await quote(t));
		if (!placed.ok) throw new Error("placeOrder failed");
		// Garante o estado de partida: o pedido com reserva já saiu de awaiting_payment.
		await withUserTransaction(staff(t), (client) => refreshOrderState(client, placed.dossierId));

		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(insertQuote(buyerOf(t), awaiting)(c)).resolves.toBeDefined();
		});
		await withDbContext(pool, clientCtx(other), async (c) => {
			await expect(insertQuote(other, awaiting)(c)).rejects.toMatchObject({ code: "42501" });
		});
		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(insertQuote(buyerOf(t), placed.dossierId)(c)).rejects.toMatchObject({ code: "42501" });
		});
	});

	it("client never reads another client's quote", async () => {
		const t = await newTenant("ops read");
		const other = await seedClientProfile(owner, t.bureau.id);
		await seedQuote(t, await openOnlineOrder(buyerOf(t)));

		await withDbContext(pool, clientCtx(other), async (c) => {
			expect((await c.query("select 1 from order_pix_quotes")).rows).toHaveLength(0);
		});
		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			expect((await c.query("select 1 from order_pix_quotes")).rows).toHaveLength(1);
		});
	});

	it("quote price outside 10.00..5000.00 is rejected", async () => {
		const t = await newTenant("ops range");
		const dossierId = await openOnlineOrder(buyerOf(t));
		for (const price of ["9.99", "5000.01"]) {
			await expect(seedQuote(t, dossierId, price)).rejects.toMatchObject({ code: "23514" });
		}
	});

	it("rejects an order charge with an amount different from the quote", async () => {
		const t = await newTenant("ops amount");
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId, "50.00");

		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(insertCharge(buyerOf(t), dossierId, "40.00")(c)).rejects.toMatchObject({ code: "42501" });
		});
		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(insertCharge(buyerOf(t), dossierId, "50.00")(c)).resolves.toBeDefined();
		});
	});

	it("rejects an order charge for another client's order", async () => {
		const t = await newTenant("ops foreign");
		const other = await seedClientProfile(owner, t.bureau.id);
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId);

		await withDbContext(pool, clientCtx(other), async (c) => {
			await expect(insertCharge(other, dossierId, "50.00")(c)).rejects.toMatchObject({ code: "42501" });
		});
	});

	it("rejects a second live charge for the same order", async () => {
		const t = await newTenant("ops live");
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId);
		const first = await ownerCharge(t, dossierId, "pending");

		await expect(ownerCharge(t, dossierId, "pending")).rejects.toMatchObject({ code: "23505" });
		await expect(ownerCharge(t, dossierId, "paid")).rejects.toMatchObject({ code: "23505" });
		await owner.query("update pix_charges set status = 'cancelled' where asaas_payment_id = $1", [first]);
		await expect(ownerCharge(t, dossierId, "pending")).resolves.toBeTypeOf("string");
	});

	it("rejects an order charge with billing CREDIT_CARD", async () => {
		const t = await newTenant("ops card");
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId);

		await expect(owner.query(chargeSql, [t.bureau.id, newPaymentId(), "50.00", "pending", t.client.userId, dossierId, "CREDIT_CARD"])).rejects.toMatchObject({
			code: "23514",
			constraint: "pix_charges_order_shape_check",
		});
	});

	it("quote is immutable", async () => {
		const t = await newTenant("ops immutable");
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId);

		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(c.query("update order_pix_quotes set price = 20.00")).rejects.toMatchObject({ code: "42501" });
		});
		await withDbContext(pool, clientCtx(buyerOf(t)), async (c) => {
			await expect(c.query("delete from order_pix_quotes")).rejects.toMatchObject({ code: "42501" });
		});
	});

	it("keeps the order PIX out of the top-up list and the top-up pending cap", async () => {
		const t = await newTenant("ops topup apart");
		const dossierId = await openOnlineOrder(buyerOf(t));
		await seedQuote(t, dossierId);
		await ownerCharge(t, dossierId, "pending");

		const buyer = buyerOf(t);
		expect(await withUserTransaction(buyer, (c) => listClientPixCharges(c, buyer.userId))).toEqual([]);
		expect(await withUserTransaction(buyer, (c) => countPendingClientPixCharges(c, buyer.userId))).toBe(0);
	});
});
