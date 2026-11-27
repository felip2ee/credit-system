// Correções da revisão dos cupons (migração 051). Postgres real, sob RLS.
// Pedido preso por estorno de recarga do Bureau, conta do balcão com cupom aberto, repetição concorrente da reserva.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
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

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedOrderCatalog,
	seedOrderDossier,
	seedOrderDossierForSession,
	seedPixCharge,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string };
const clientCtx = (t: SeededTenant): Ctx => ({ userId: t.client.userId, role: "client", bureauId: t.bureau.id });
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });

async function begin(ctx: Ctx): Promise<PoolClient> {
	const client = await app.connect();
	await client.query("begin");
	await client.query(
		`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
		        set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
		[ctx.userId, ctx.role, ctx.bureauId],
	);
	return client;
}
async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await begin(ctx);
	try {
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
const reserveCall = (c: PoolClient, o: { orderRef: string; clientId: string | null; price: string; cost: string; code: string | null }) =>
	c
		.query<SettleRow>("select * from reserve_order($1, $2, $3, $4, $5, $6::jsonb, $7)", [
			o.orderRef, o.clientId ? "online" : "counter", o.clientId, o.price, o.cost, JSON.stringify({ lines: [] }), o.code,
		])
		.then((r) => r.rows[0]);
const capture = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]));
const release = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from release_order($1)", [ref]).then((r) => r.rows[0]));

async function rows<R>(sql: string, params: unknown[] = []): Promise<R[]> {
	return (await owner.query(sql, params)).rows as R[];
}
const bureauWallet = async (id: string) =>
	(await rows<{ available: string; reserved: string }>("select available, reserved from wallets where bureau_id = $1", [id]))[0];
const clientWallet = async (id: string) =>
	(await rows<{ available: string; reserved: string }>("select available, reserved from client_wallets where client_profile_id = $1", [id]))[0];
const redemption = async (orderRef: string) =>
	(await rows<{ status: string; funded_wallet: string }>("select status, funded_wallet from coupon_redemptions where order_ref = $1", [orderRef]))[0];

async function seedCoupon(t: SeededTenant, value: string, maxUses: number | null = null): Promise<string> {
	const code = `R${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, valid_from, active, created_by)
		 values ($1, $2, 'percent', $3, true, $4, now() - interval '1 hour', true, $5)`,
		[t.bureau.id, code, value, maxUses, t.bureauAdmin.userId],
	);
	return code;
}

const couponIdOf = async (code: string) =>
	(await rows<{ id: string }>("select id from coupons where code = $1", [code]))[0].id;

// Pedido online com cupom reservado antes da 072: o Bureau cobriu a falta (custo - preço pago) pela carteira. Desde a 072
// reserve_order não cobre mais a falta; esse caminho segue valendo para os pedidos que já estavam reservados.
async function placeLegacyCoupon(
	t: SeededTenant,
	o: { list: string; commissionPct: string; paid: string; code: string; fundedWallet: string },
): Promise<string> {
	return seedLegacyOnlineOrder(owner, {
		bureauId: t.bureau.id,
		clientProfileId: t.client.userId,
		price: o.paid,
		commissionPct: o.commissionPct,
		coupon: { couponId: await couponIdOf(o.code), discount: (Number(o.list) - Number(o.paid)).toFixed(2), fundedWallet: o.fundedWallet },
	});
}

// Estorno (Pix pago) de uma recarga do Bureau do valor dado.
async function refundBureauTopup(t: SeededTenant, amount: string) {
	const charge = await seedPixCharge(owner, { bureauId: t.bureau.id, requestedBy: t.bureauAdmin.userId, amount, status: "paid" });
	const out = await hook.query<{ apply_asaas_payment: string }>(
		"select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)",
		[`evt-${randomBytes(6).toString("hex")}`, charge.asaasPaymentId],
	);
	expect(out.rows[0].apply_asaas_payment).toBe("refunded");
}

// Cliente com 50, carteira do Bureau com 100, cupom de 50%: paga 50, o Bureau cobre 10 da carteira (pedido legado).
async function stuckSetup(label: string) {
	const t = await seedTenant(owner, label);
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "50.00", createdBy: t.client.userId });
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
	const code = await seedCoupon(t, "50");
	const orderRef = await placeLegacyCoupon(t, { list: "100.00", commissionPct: "40", paid: "50.00", code, fundedWallet: "10.00" });
	expect(await bureauWallet(t.bureau.id)).toEqual({ available: "90.00", reserved: "10.00" });
	return { t, orderRef };
}

describe("estorno da recarga do Bureau come a reserva do cupom", () => {
	it("capture takes the clawback branch instead of raising and gives the client reserve back", async () => {
		const { t, orderRef } = await stuckSetup("rev capture");
		await refundBureauTopup(t, "95.00");
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "5.00" });

		expect(await capture(t, orderRef)).toEqual({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect(await redemption(orderRef)).toMatchObject({ status: "released" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "50.00", reserved: "0.00" });
		// Libera só o que restava (5 de 10), sem erro.
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "5.00", reserved: "0.00" });
	});

	it("cancel releases least(funded_wallet, reserved) without raising and unlocks the client reserve", async () => {
		const { t, orderRef } = await stuckSetup("rev cancel");
		await refundBureauTopup(t, "100.00");
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });

		expect(await release(t, orderRef)).toMatchObject({ ok: true, status: "released" });
		expect(await redemption(orderRef)).toMatchObject({ status: "released" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "50.00", reserved: "0.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await rows("select 1 from audit_logs where record_id = (select id from coupon_redemptions where order_ref = $1) and action = 'coupon.release'", [orderRef])).toHaveLength(1);
	});

	it("without a refund capture still captures and the Bureau wallet entries carry the reason 'cupom'", async () => {
		const { t, orderRef } = await stuckSetup("rev reason");
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "90.00", reserved: "0.00" });
		const entries = await rows<{ kind: string; reason: string | null }>(
			"select kind, reason from ledger_entries where bureau_id = $1 and reference = $2 order by created_at, id",
			[t.bureau.id, `order:${orderRef}`],
		);
		expect(entries).toEqual([
			{ kind: "reserve", reason: "cupom" },
			{ kind: "capture", reason: "cupom" },
		]);
	});
});

describe("pedido de balcão com cupom aberto na mesma carteira", () => {
	it("does not give the coupon reserve to the counter order when a refund clawed back the wallet", async () => {
		const t = await seedTenant(owner, "rev balcão");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		// Balcão (a mais antiga): reserva 70.
		const counterRef = randomUUID();
		await committed(adminCtx(t), async (c) => {
			await seedOrderDossierForSession(owner, c, { orderRef: counterRef, clientProfileId: null });
			await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "80.00", cost: "70.00" });
			return reserveCall(c, { orderRef: counterRef, clientId: null, price: "80.00", cost: "70.00", code: null });
		});
		// Online com cupom de 100%: o Bureau cobre os 30 do custo pela carteira.
		const code = await seedCoupon(t, "100");
		const couponRef = await placeLegacyCoupon(t, { list: "40.00", commissionPct: "25", paid: "0.00", code, fundedWallet: "30.00" });
		expect(await redemption(couponRef)).toMatchObject({ status: "reserved", funded_wallet: "30.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "100.00" });

		// O estorno de 70 tira da reserva (disponível 0): sobram 30, que são do cupom.
		await refundBureauTopup(t, "70.00");
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "30.00" });

		expect(await capture(t, counterRef)).toEqual({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "30.00" });
		expect(await capture(t, couponRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
	});
});

describe("repetição concorrente da mesma reserva com cupom", () => {
	it("a retry that waited for the coupon lock returns the first result, not coupon_exhausted", async () => {
		const t = await seedTenant(owner, "rev retry");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.client.userId });
		const code = await seedCoupon(t, "10", 1);
		const orderRef = randomUUID();
		await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
		await committed(clientCtx(t), (c) => seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "100.00", cost: "60.00" }));
		const call = { orderRef, clientId: t.client.userId, price: "90.00", cost: "60.00", code };

		const first = await begin(clientCtx(t));
		const second = await begin(clientCtx(t));
		try {
			expect(await reserveCall(first, call)).toMatchObject({ ok: true, status: "reserved" });
			// A segunda espera a trava do cupom (ou a linha da liquidação) até a primeira gravar.
			const pending = reserveCall(second, call);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await first.query("commit");
			expect(await pending).toEqual({ ok: true, reason: null, status: "reserved" });
			await second.query("commit");
		} finally {
			first.release();
			second.release();
		}
		expect(await rows("select 1 from coupon_redemptions where order_ref = $1", [orderRef])).toHaveLength(1);
		expect(await clientWallet(t.client.userId)).toEqual({ available: "10.00", reserved: "90.00" });
	});
});
