// placeOrder com cupom (camada TypeScript sobre reserve_order e coupon_preview), contra um Postgres real, sob RLS.
// Preço de venda 50,00 e custo 1,00 (dossie_pf). O dinheiro em si é testado em settlement/coupons.integration.test.ts.
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
import { previewCoupon } from "@/lib/coupons/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedBureauCost, seedCatalogItem, seedClientWalletTopup, seedTenant, seedWalletTopup, type SeededTenant } from "@/test/seed";

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

async function newTenant(label: string, funds: { client?: string; bureau?: string } = { client: "200.00", bureau: "200.00" }) {
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

async function seedCoupon(
	t: SeededTenant,
	i: { kind?: "percent" | "fixed"; value: string; maxUses?: number; maxUsesPerClient?: number; active?: boolean; allProducts?: boolean; productCodes?: string[] },
): Promise<string> {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, max_uses_per_client, valid_from, active, created_by)
		 values ($1, $2, $3, $4, $5, $6, $7, now() - interval '1 hour', $8, $9) returning id`,
		[t.bureau.id, code, i.kind ?? "percent", i.value, i.allProducts ?? true, i.maxUses ?? null, i.maxUsesPerClient ?? null, i.active ?? true, t.bureauAdmin.userId],
	);
	for (const productCode of i.productCodes ?? []) {
		await owner.query("insert into coupon_products (coupon_id, bureau_id, product_id) select $1, $2, id from products where code = $3", [
			rows[0].id,
			t.bureau.id,
			productCode,
		]);
	}
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
const clientWallet = async (t: SeededTenant) =>
	(await rows("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId]))[0];
const redemptions = (t: SeededTenant) =>
	rows<{ status: string; discount: string }>("select status, discount from coupon_redemptions where bureau_id = $1", [t.bureau.id]);
const orders = async (t: SeededTenant) =>
	Number((await rows<{ n: string }>("select count(*) as n from dossier_orders where bureau_id = $1", [t.bureau.id]))[0].n);

describe("placeOrder with a coupon", () => {
	it("percent: the paid price (list minus discount) is reserved on the client wallet and the redemption is recorded", async () => {
		const t = await newTenant("pcp pct");
		const code = await seedCoupon(t, { value: "20" });

		const result = await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code });

		expect(result).toMatchObject({ ok: true });
		expect(await clientWallet(t)).toEqual({ available: "160.00", reserved: "40.00" });
		expect(await redemptions(t)).toEqual([{ status: "reserved", discount: "10.00" }]);
		const [settlement] = await rows("select price, discount from order_settlements where bureau_id = $1", [t.bureau.id]);
		expect(settlement).toEqual({ price: "40.00", discount: "10.00" });
	});

	it("fixed above the price: paid 0 leaves the client wallet untouched", async () => {
		const t = await newTenant("pcp fixed", { client: "200.00", bureau: "200.00" });
		const code = await seedCoupon(t, { kind: "fixed", value: "80" });

		const result = await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code });

		expect(result).toMatchObject({ ok: true });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await redemptions(t)).toEqual([{ status: "reserved", discount: "50.00" }]);
	});

	it("100% coupon opens the order for a client with no balance", async () => {
		const t = await newTenant("pcp zero", { bureau: "200.00" });
		const code = await seedCoupon(t, { value: "100" });

		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toMatchObject({ ok: true });
	});

	it("an unusable coupon is coupon_invalid and leaves no order, wallet change or redemption", async () => {
		const t = await newTenant("pcp bad");
		const inactive = await seedCoupon(t, { value: "20", active: false });
		const otherProduct = await seedCoupon(t, { value: "20", allProducts: false, productCodes: ["dossie_empresarial"] });
		const used = await seedCoupon(t, { value: "20", maxUses: 1 });
		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: used })).toMatchObject({ ok: true });
		const before = await orders(t);

		for (const couponCode of ["NAOEXISTE", inactive, otherProduct, used]) {
			expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode })).toEqual({ ok: false, reason: "coupon_invalid" });
		}
		expect(await orders(t)).toBe(before);
		expect(await redemptions(t)).toHaveLength(1);
		expect(await clientWallet(t)).toEqual({ available: "160.00", reserved: "40.00" });
	});

	it("a coupon from another Bureau is coupon_invalid", async () => {
		const t = await newTenant("pcp own");
		const other = await newTenant("pcp other");
		const code = await seedCoupon(other, { value: "20" });

		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toEqual({ ok: false, reason: "coupon_invalid" });
	});

	it("the counter (staff) never uses a coupon", async () => {
		const t = await newTenant("pcp counter");
		const code = await seedCoupon(t, { value: "20" });
		const counterInput: OpenOrderInput = {
			...input,
			self: false,
			subject: { type: "PF", name: "Fulano de Tal", documentDigits: "39053344705" },
			contact: { email: "titular@example.com", phoneE164: null },
		};

		expect(await placeOrder(staff(t), counterInput, await quote(t), { couponCode: code })).toEqual({ ok: false, reason: "coupon_invalid" });
	});

	it("a coupon only lowers the price paid: the Bureau funds nothing, even with no Bureau balance", async () => {
		const t = await newTenant("pcp funds", { client: "200.00" });
		const code = await seedCoupon(t, { value: "100" });

		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toMatchObject({ ok: true });
		expect(await redemptions(t)).toEqual([{ status: "reserved", discount: "50.00" }]);
		const [funded] = await rows("select funded_wallet, funded_payable from coupon_redemptions where bureau_id = $1", [t.bureau.id]);
		expect(funded).toEqual({ funded_wallet: "0.00", funded_payable: "0.00" });
		expect(await rows("select 1 from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toEqual([]);
	});
});

describe("previewCoupon", () => {
	it("returns kind, value and the accepted products, and creates no redemption", async () => {
		const t = await newTenant("pcv ok");
		const code = await seedCoupon(t, { kind: "fixed", value: "12.50", allProducts: false, productCodes: ["dossie_pf"] });

		const preview = await withUserTransaction(buyerOf(t), (c) => previewCoupon(c, ` ${code.toLowerCase()} `, ["dossie_pf"]));

		expect(preview).toMatchObject({ kind: "fixed", value: 12.5, eligibleProductCodes: ["dossie_pf"] });
		expect(await redemptions(t)).toHaveLength(0);
	});

	it("is null for an unknown code, an inactive coupon and a product the coupon does not accept", async () => {
		const t = await newTenant("pcv null");
		const inactive = await seedCoupon(t, { value: "10", active: false });
		const other = await seedCoupon(t, { value: "10", allProducts: false, productCodes: ["dossie_empresarial"] });

		for (const code of ["NAOEXISTE", inactive, other]) {
			expect(await withUserTransaction(buyerOf(t), (c) => previewCoupon(c, code, ["dossie_pf"]))).toBeNull();
		}
		expect(await redemptions(t)).toHaveLength(0);
	});

	it("does not answer for staff", async () => {
		const t = await newTenant("pcv staff");
		const code = await seedCoupon(t, { value: "10" });

		expect(await withUserTransaction(staff(t), (c) => previewCoupon(c, code, ["dossie_pf"]))).toBeNull();
	});
});
