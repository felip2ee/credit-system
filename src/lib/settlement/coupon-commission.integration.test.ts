// Cupom x comissão do Bureau (migrações 055 e 072) contra um Postgres real, sob RLS.
// Preço de tabela 400,00. Desde a 072 o pedido online novo não gera comissão do Bureau nem do afiliado na captura (elas
// vêm do split da entrada de dinheiro) e o cupom só baixa o valor pago: o Bureau não cobre falta nenhuma. O pedido
// reservado antes da 072 (Bureau 20% = 80,00, afiliado 10% do bruto = 40,00) segue com a regra antiga na captura.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedOrderCatalog,
	seedOrderDossier,
	seedPixCharge,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string };
const clientCtx = (t: SeededTenant): Ctx => ({ userId: t.client.userId, role: "client", bureauId: t.bureau.id });
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
			        set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type SettleRow = { ok: boolean; reason: string | null; status: string | null };
const rows = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await owner.query(sql, params)).rows as R[];

// Locatário com saldo do cliente, carteira do Bureau e afiliado (10% do bruto) já ligado ao cliente.
async function tenant(label: string, o: { client?: string; wallet?: string; affiliatePct?: string | null } = {}) {
	const t = await seedTenant(owner, label);
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: o.client ?? "500.00", createdBy: t.client.userId });
	if (o.wallet) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: o.wallet, createdBy: t.bureauAdmin.userId });
	const pct = o.affiliatePct === undefined ? "10" : o.affiliatePct;
	let affiliateId: string | null = null;
	if (pct !== null) {
		const affiliate = await seedClientProfile(owner, t.bureau.id);
		affiliateId = affiliate.userId;
		await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
			t.client.userId, affiliate.userId, t.bureau.id,
		]);
		const conn = await owner.connect();
		try {
			await conn.query("begin");
			await conn.query("set local session_replication_role = replica");
			await conn.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [t.client.userId]);
			await conn.query("commit");
		} finally {
			conn.release();
		}
		await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, $2)", [t.bureau.id, pct]);
	}
	return { t, affiliateId };
}

async function seedCoupon(t: SeededTenant, kind: "percent" | "fixed", value: string): Promise<string> {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, valid_from, active, created_by)
		 values ($1, $2, $3, $4, true, now() - interval '1 hour', true, $5)`,
		[t.bureau.id, code, kind, value, t.bureauAdmin.userId],
	);
	return code;
}

// Reserva um pedido online de preço de tabela 400 e custo (parte da plataforma) 320. `paid` é o preço pago.
async function reserve(t: SeededTenant, paid: string, code: string | null): Promise<{ orderRef: string; res: SettleRow }> {
	const orderRef = randomUUID();
	await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
	await committed(clientCtx(t), (c) => seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "400.00", cost: "320.00" }));
	const res = await committed(clientCtx(t), (c) =>
		c
			.query<SettleRow>("select * from reserve_order($1, 'online', $2, $3, $4, $5::jsonb, $6)", [
				orderRef, t.client.userId, paid, "320.00", JSON.stringify({ lines: [] }), code,
			])
			.then((r) => r.rows[0]),
	);
	return { orderRef, res };
}
const capture = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]));
const release = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from release_order($1)", [ref]).then((r) => r.rows[0]));

const settlement = async (ref: string) =>
	(
		await rows<{ price: string; cost: string; discount: string; commission_pct: string | null; bureau_commission: string | null }>(
			"select price, cost, discount, commission_pct, bureau_commission from order_settlements where order_ref = $1",
			[ref],
		)
	)[0];
const payables = (bureauId: string) =>
	rows<{ kind: string; amount: string }>("select kind, amount from bureau_payable_entries where bureau_id = $1 order by created_at, id", [bureauId]);
const commissions = (bureauId: string) =>
	rows<{ pct: string; margin: string; amount: string; status: string; reversed_amount: string }>(
		"select pct, margin, amount, status, reversed_amount from affiliate_commissions where bureau_id = $1 order by created_at, id",
		[bureauId],
	);
const bureauWallet = async (id: string) =>
	(await rows<{ available: string; reserved: string }>("select available, reserved from wallets where bureau_id = $1", [id]))[0];

// Pedido reservado antes da 072: Bureau 20% sobre o bruto (400,00), cupom fixo de `discount` já descontado de `paid`.
async function legacyOrder(t: SeededTenant, paid: string, code: string | null, discount: string): Promise<string> {
	const couponId = code ? (await rows<{ id: string }>("select id from coupons where code = $1", [code]))[0].id : null;
	return seedLegacyOnlineOrder(owner, {
		bureauId: t.bureau.id,
		clientProfileId: t.client.userId,
		price: paid,
		commissionPct: "20",
		coupon: couponId ? { couponId, discount } : undefined,
	});
}

describe("cupom x comissão (072): o cupom só baixa o valor pago", () => {
	it("fixed 50: price paid 350, no Bureau funds, no accrual and no affiliate commission at capture", async () => {
		const { t } = await tenant("cc fixed", { wallet: "500.00" });
		const code = await seedCoupon(t, "fixed", "50.00");
		const { orderRef, res } = await reserve(t, "350.00", code);
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await settlement(orderRef)).toEqual({
			price: "350.00", cost: "0.00", discount: "50.00", commission_pct: null, bureau_commission: null,
		});
		expect(await rows("select discount, funded_wallet, funded_payable from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([
			{ discount: "50.00", funded_wallet: "0.00", funded_payable: "0.00" },
		]);
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await payables(t.bureau.id)).toEqual([]);
		expect(await commissions(t.bureau.id)).toEqual([]);
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "500.00", reserved: "0.00" });
	});

	it("a discount above the old Bureau commission is accepted with an empty Bureau wallet (no gap to cover)", async () => {
		const { t } = await tenant("cc gap");
		const code = await seedCoupon(t, "fixed", "100.00");
		const { orderRef, res } = await reserve(t, "300.00", code);
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await rows("select funded_wallet, funded_payable from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([
			{ funded_wallet: "0.00", funded_payable: "0.00" },
		]);
	});

	it("100% coupon (paid 0): the order is captured with nothing from the Bureau and nothing to the affiliate", async () => {
		const { t } = await tenant("cc free");
		const code = await seedCoupon(t, "percent", "100");
		const { orderRef, res } = await reserve(t, "0.00", code);
		expect(res.ok).toBe(true);
		expect(await settlement(orderRef)).toMatchObject({ price: "0.00", discount: "400.00", cost: "0.00", bureau_commission: null });
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await payables(t.bureau.id)).toEqual([]);
		expect(await commissions(t.bureau.id)).toEqual([]);
	});

	it("without a coupon the order has the same shape: cost 0, no commission, no accrual", async () => {
		const { t } = await tenant("cc plain");
		const { orderRef } = await reserve(t, "400.00", null);
		expect(await settlement(orderRef)).toMatchObject({ price: "400.00", discount: "0.00", cost: "0.00", commission_pct: null });
		await capture(t, orderRef);
		expect(await payables(t.bureau.id)).toEqual([]);
		expect(await commissions(t.bureau.id)).toEqual([]);
	});

	it("a wrong paid price is price_mismatch (the check uses the gross list price minus the discount)", async () => {
		const { t } = await tenant("cc mismatch");
		const code = await seedCoupon(t, "fixed", "50.00");
		const { res } = await reserve(t, "400.00", code);
		expect(res).toMatchObject({ ok: false, reason: "price_mismatch" });
	});

	it("release: the redemption is returned and nothing else moves", async () => {
		const { t } = await tenant("cc release", { wallet: "500.00" });
		const code = await seedCoupon(t, "fixed", "100.00");
		const { orderRef } = await reserve(t, "300.00", code);
		expect(await release(t, orderRef)).toMatchObject({ ok: true, status: "released" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "500.00", reserved: "0.00" });
		expect(await rows("select status from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([{ status: "released" }]);
		expect(await payables(t.bureau.id)).toEqual([]);
		expect(await commissions(t.bureau.id)).toEqual([]);
	});
});

describe("transição: pedido com cupom reservado antes da 072", () => {
	it("keeps the old rule at capture: Bureau 80 - 50 = 30, affiliate 10% of the gross 400", async () => {
		const { t } = await tenant("cc legacy");
		const code = await seedCoupon(t, "fixed", "50.00");
		const orderRef = await legacyOrder(t, "350.00", code, "50.00");
		expect(await settlement(orderRef)).toEqual({
			price: "350.00", cost: "320.00", discount: "50.00", commission_pct: "20.00", bureau_commission: "80.00",
		});
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "30.00" }]);
		expect(await commissions(t.bureau.id)).toEqual([
			{ pct: "10.00", margin: "400.00", amount: "40.00", status: "pending", reversed_amount: "0.00" },
		]);
	});

	it("a discount that wipes the Bureau commission leaves no accrual, and the affiliate is still paid on the gross", async () => {
		const { t } = await tenant("cc legacy zero");
		const code = await seedCoupon(t, "fixed", "100.00");
		const orderRef = await legacyOrder(t, "300.00", code, "100.00");
		await capture(t, orderRef);
		expect(await payables(t.bureau.id)).toEqual([]);
		expect((await commissions(t.bureau.id)).map((c) => [c.margin, c.amount])).toEqual([["400.00", "40.00"]]);
	});

	it("a new order and a legacy order of the same Bureau do not mix: only the legacy one is commissioned at capture", async () => {
		const { t } = await tenant("cc mixed", { client: "1000.00" });
		const fresh = await reserve(t, "400.00", null);
		const legacy = await legacyOrder(t, "400.00", null, "0.00");
		await capture(t, fresh.orderRef);
		await capture(t, legacy);
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "80.00" }]);
		expect((await commissions(t.bureau.id)).map((c) => c.amount)).toEqual(["40.00"]);
		expect(await rows("select 1 from bureau_payable_entries where order_ref = $1", [fresh.orderRef])).toEqual([]);
	});
});

describe("cupom x comissão: estorno de Pix depois da captura", () => {
	const refund = (asaasPaymentId: string) =>
		hook
			.query<{ apply_asaas_payment: string }>("select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [
				`evt-${randomBytes(6).toString("hex")}`,
				asaasPaymentId,
			])
			.then((r) => r.rows[0].apply_asaas_payment);

	it("reverts the pending affiliate commission first, then claws back the Bureau accrual of a pre-072 order", async () => {
		const { t } = await tenant("cc refund", { client: "0.01" });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "400.00", status: "paid",
		});
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "399.99", createdBy: t.client.userId });
		const code = await seedCoupon(t, "fixed", "50.00");
		const orderRef = await legacyOrder(t, "350.00", code, "50.00");
		await capture(t, orderRef);
		// Saldo do cliente: 400,00 - 350,00 = 50,00. O Bureau tem acréscimo 30; o afiliado, 40 pendentes.
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		// O estorno é de 400: a carteira devolve 50; falta 350. 40 vêm da comissão do afiliado (revertida primeiro) e 30
		// do acréscimo do Bureau; o resto (280) é refund_shortfall. O pedido capturado e a redenção ficam como estavam.
		expect((await commissions(t.bureau.id)).map((c) => [c.status, c.reversed_amount])).toEqual([["reversed", "40.00"]]);
		expect((await payables(t.bureau.id)).map((p) => [p.kind, p.amount])).toEqual([["accrual", "30.00"], ["reversal", "-30.00"]]);
		expect(await rows("select refund_shortfall from pix_charges where id = $1", [charge.id])).toEqual([{ refund_shortfall: "280.00" }]);
		expect((await settlement(orderRef)).price).toBe("350.00");
		expect(await rows("select status from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([{ status: "consumed" }]);
	});
});
