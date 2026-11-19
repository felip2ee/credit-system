// Cupom x comissão do Bureau (migração 055 sobre as 048-054) contra um Postgres real, sob RLS.
// Preço de tabela 400,00; Bureau 20% (80,00); parte da plataforma 320,00; afiliado 10% do bruto (40,00).
// Regra: o desconto do cupom sai da comissão do Bureau. A parte da plataforma não muda. A comissão do afiliado é sobre
// o preço bruto. Pedido com preço pago menor que a parte da plataforma: o Bureau cobre a falta (carteira ou repasse).
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossier,
	seedPayableEntry,
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
		await rows<{ price: string; cost: string; discount: string; commission_pct: string; bureau_commission: string }>(
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

describe("cupom x comissão: o desconto sai da comissão do Bureau", () => {
	it("fixed 50: Bureau earns 80 - 50 = 30, affiliate gets 10% of the gross 400, platform share stays 320", async () => {
		const { t, affiliateId } = await tenant("cc fixed");
		const code = await seedCoupon(t, "fixed", "50.00");
		const { orderRef, res } = await reserve(t, "350.00", code);
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		// Snapshot: price é o preço pago; price + discount é o bruto sobre o qual valem as comissões.
		expect(await settlement(orderRef)).toEqual({
			price: "350.00", cost: "320.00", discount: "50.00", commission_pct: "20.00", bureau_commission: "80.00",
		});
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "30.00" }]);
		expect(await commissions(t.bureau.id)).toEqual([
			{ pct: "10.00", margin: "400.00", amount: "40.00", status: "pending", reversed_amount: "0.00" },
		]);
		expect(await rows("select 1 from affiliate_commissions where affiliate_profile_id = $1", [affiliateId])).toHaveLength(1);
		// Plataforma: recebe 350 do cliente, paga 30 ao Bureau e 40 ao afiliado = fica com 280 (= 320 - 40).
		expect(350 - 30 - 40).toBe(280);
	});

	it("percent 10% (discount 40) takes the whole Bureau commission to 40; percent 20% (80) takes it to 0", async () => {
		const { t } = await tenant("cc percent", { client: "1000.00" });
		const ten = await seedCoupon(t, "percent", "10");
		const a = await reserve(t, "360.00", ten);
		expect(a.res.ok).toBe(true);
		expect(await settlement(a.orderRef)).toMatchObject({ price: "360.00", discount: "40.00", cost: "320.00" });
		await capture(t, a.orderRef);

		const twenty = await seedCoupon(t, "percent", "20");
		const b = await reserve(t, "320.00", twenty);
		expect(b.res.ok).toBe(true);
		await capture(t, b.orderRef);
		// Paga 320 = parte da plataforma: nenhuma falta, e o Bureau fica com 0 nesta venda.
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "40.00" }]);
		// O afiliado recebe 40 nas duas vendas: a base é o bruto, não o preço pago.
		expect((await commissions(t.bureau.id)).map((c) => [c.margin, c.amount])).toEqual([
			["400.00", "40.00"],
			["400.00", "40.00"],
		]);
	});

	it("discount above the Bureau commission: the Bureau wallet covers the gap and the platform share is intact", async () => {
		const { t } = await tenant("cc gap", { wallet: "500.00" });
		const code = await seedCoupon(t, "fixed", "100.00");
		const { orderRef, res } = await reserve(t, "300.00", code);
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		// Falta = parte da plataforma (320) - pago (300) = 20 = desconto (100) - comissão do Bureau (80).
		expect(await rows("select discount, funded_wallet, funded_payable from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([
			{ discount: "100.00", funded_wallet: "20.00", funded_payable: "0.00" },
		]);
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "480.00", reserved: "20.00" });
		await capture(t, orderRef);
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "480.00", reserved: "0.00" });
		// O Bureau não recebe acréscimo; o afiliado recebe os 40 do bruto, da parte da plataforma (300 + 20 - 40 = 280).
		expect(await payables(t.bureau.id)).toEqual([]);
		expect((await commissions(t.bureau.id)).map((c) => c.amount)).toEqual(["40.00"]);
	});

	it("100% coupon (paid 0): the Bureau pays the whole platform share and the affiliate is still paid on the gross", async () => {
		const { t } = await tenant("cc free", { wallet: "500.00" });
		const code = await seedCoupon(t, "percent", "100");
		const { orderRef, res } = await reserve(t, "0.00", code);
		expect(res.ok).toBe(true);
		expect(await settlement(orderRef)).toMatchObject({ price: "0.00", discount: "400.00", cost: "320.00", bureau_commission: "80.00" });
		expect(await rows("select funded_wallet from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([{ funded_wallet: "320.00" }]);
		await capture(t, orderRef);
		expect(await payables(t.bureau.id)).toEqual([]);
		expect((await commissions(t.bureau.id)).map((c) => [c.margin, c.amount])).toEqual([["400.00", "40.00"]]);
	});

	it("without an affiliate: the coupon order has no commission row", async () => {
		const { t } = await tenant("cc no aff", { affiliatePct: null });
		const code = await seedCoupon(t, "fixed", "50.00");
		const { orderRef } = await reserve(t, "350.00", code);
		await capture(t, orderRef);
		expect(await commissions(t.bureau.id)).toEqual([]);
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "30.00" }]);
	});

	it("without a coupon nothing changes: Bureau 80, affiliate 40, snapshot has no discount", async () => {
		const { t } = await tenant("cc plain");
		const { orderRef } = await reserve(t, "400.00", null);
		expect(await settlement(orderRef)).toMatchObject({ price: "400.00", discount: "0.00", cost: "320.00", bureau_commission: "80.00" });
		await capture(t, orderRef);
		expect(await payables(t.bureau.id)).toEqual([{ kind: "accrual", amount: "80.00" }]);
		expect((await commissions(t.bureau.id)).map((c) => c.amount)).toEqual(["40.00"]);
	});

	it("a wrong paid price is price_mismatch (the check uses the gross list price minus the discount)", async () => {
		const { t } = await tenant("cc mismatch", { wallet: "500.00" });
		const code = await seedCoupon(t, "fixed", "50.00");
		const { res } = await reserve(t, "400.00", code);
		expect(res).toMatchObject({ ok: false, reason: "price_mismatch" });
	});

	it("release: nothing is earned, the Bureau wallet and the redemption are returned, no affiliate commission", async () => {
		const { t } = await tenant("cc release", { wallet: "500.00" });
		const code = await seedCoupon(t, "fixed", "100.00");
		const { orderRef } = await reserve(t, "300.00", code);
		expect(await release(t, orderRef)).toMatchObject({ ok: true, status: "released" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "500.00", reserved: "0.00" });
		expect(await rows("select status from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([{ status: "released" }]);
		expect(await payables(t.bureau.id)).toEqual([]);
		expect(await commissions(t.bureau.id)).toEqual([]);
	});

	it("gap above the wallet is taken from the released payable balance, and the coupon is refused with no funds", async () => {
		const { t } = await tenant("cc payable", { wallet: "5.00" });
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "100.00", createdAt: "2020-01-01T00:00:00Z" });
		const code = await seedCoupon(t, "fixed", "100.00");
		const { orderRef, res } = await reserve(t, "300.00", code);
		expect(res.ok).toBe(true);
		// Falta 20: carteira cobre 5, o repasse liberado cobre 15.
		expect(await rows("select funded_wallet, funded_payable from coupon_redemptions where order_ref = $1", [orderRef])).toEqual([
			{ funded_wallet: "5.00", funded_payable: "15.00" },
		]);
		expect((await payables(t.bureau.id)).map((p) => [p.kind, p.amount])).toEqual([["accrual", "100.00"], ["coupon_cost", "-15.00"]]);

		const poor = await tenant("cc no funds", { wallet: "1.00" });
		const code2 = await seedCoupon(poor.t, "fixed", "100.00");
		const refused = await reserve(poor.t, "300.00", code2);
		expect(refused.res).toMatchObject({ ok: false, reason: "coupon_funds_insufficient" });
		expect(await rows("select 1 from order_settlements where order_ref = $1", [refused.orderRef])).toEqual([]);
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

	it("reverts the pending affiliate commission first, then claws back the Bureau accrual; the coupon settlement is not undone", async () => {
		const { t } = await tenant("cc refund", { client: "0.01" });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "400.00", status: "paid",
		});
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "399.99", createdBy: t.client.userId });
		const code = await seedCoupon(t, "fixed", "50.00");
		const { orderRef } = await reserve(t, "350.00", code);
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
