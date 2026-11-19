// Limite de tentativas de código (052) pela ação do pedido: placeOrder dá rollback com cupom inválido, então o erro
// é contado numa transação própria (053, coupon_record_miss). Postgres real, sob RLS.
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

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import type { DbIdentity } from "@/lib/db/transaction";
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
	i: { value?: string; maxUses?: number; maxUsesPerClient?: number; active?: boolean; expired?: boolean } = {},
): Promise<string> {
	const code = `M${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, max_uses_per_client, valid_from, valid_until, active, created_by)
		 values ($1, $2, 'percent', $3, true, $4, $5, now() - interval '2 hours', $6, $7, $8)`,
		[
			t.bureau.id,
			code,
			i.value ?? "20",
			i.maxUses ?? null,
			i.maxUsesPerClient ?? null,
			i.expired ? new Date(Date.now() - 3_600_000) : null,
			i.active ?? true,
			t.bureauAdmin.userId,
		],
	);
	return code;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });
const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });
const misses = async (t: SeededTenant) =>
	Number((await owner.query("select count(*) from coupon_attempt_misses where profile_id = $1", [t.client.userId])).rows[0].count);

async function quote(t: SeededTenant) {
	const q = await quoteOrder(staff(t), "dossie_pf", { partnerCount: 0 });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}
const order = async (t: SeededTenant, couponCode: string) => placeOrder(buyerOf(t), input, await quote(t), { couponCode });

describe("coupon code attempts through placeOrder", () => {
	it("counts 10 invalid codes; the 11th is refused even with a valid code; another client is unaffected", async () => {
		const t = await newTenant("cm limit");
		const other = await newTenant("cm other");
		const valid = await seedCoupon(t);
		const otherValid = await seedCoupon(other);

		for (let i = 0; i < 10; i++) expect(await order(t, `NOPE${i}`)).toEqual({ ok: false, reason: "coupon_invalid" });
		expect(await misses(t)).toBe(10);

		expect(await order(t, valid)).toEqual({ ok: false, reason: "coupon_invalid" });
		expect(await misses(t)).toBe(10);
		expect(await order(other, otherValid)).toMatchObject({ ok: true });
		expect(await misses(other)).toBe(0);
	});

	it("every code problem counts one miss: unknown, inactive, expired, exhausted, client limit", async () => {
		const t = await newTenant("cm reasons");
		const used = await seedCoupon(t, { maxUses: 1 });
		const usedByClient = await seedCoupon(t, { maxUsesPerClient: 1 });
		expect(await order(t, used)).toMatchObject({ ok: true });
		expect(await order(t, usedByClient)).toMatchObject({ ok: true });
		expect(await misses(t)).toBe(0);

		const bad = ["NAOEXISTE", await seedCoupon(t, { active: false }), await seedCoupon(t, { expired: true }), used, usedByClient];
		for (let n = 0; n < bad.length; n++) {
			expect(await order(t, bad[n])).toEqual({ ok: false, reason: "coupon_invalid" });
			expect(await misses(t)).toBe(n + 1);
		}
	});

	it("a successful order and a Bureau funds shortfall record no miss", async () => {
		const ok = await newTenant("cm ok");
		expect(await order(ok, await seedCoupon(ok))).toMatchObject({ ok: true });
		expect(await misses(ok)).toBe(0);

		const poor = await newTenant("cm funds", { client: "200.00" });
		expect(await order(poor, await seedCoupon(poor, { value: "100" }))).toEqual({ ok: false, reason: "coupon_funds_insufficient" });
		expect(await misses(poor)).toBe(0);
	});

	it("the counter (staff) never records a miss", async () => {
		const t = await newTenant("cm counter");
		const counterInput: OpenOrderInput = {
			...input,
			self: false,
			subject: { type: "PF", name: "Fulano de Tal", documentDigits: "39053344705" },
			contact: { email: "titular@example.com", phoneE164: null },
		};
		const result = await placeOrder(staff(t), counterInput, await quote(t), { couponCode: "NAOEXISTE" });
		expect(result).toEqual({ ok: false, reason: "coupon_invalid" });
		expect(await misses(t)).toBe(0);
	});
});
