// Webhook do PIX do pedido (065): apply_asaas_payment -> apply_order_pix_charge, contra um Postgres real, sob RLS.
// Preço de venda 50,00 e custo 1,00 (dossie_pf); taxa do PIX 0,99 repassada ao pagador (D3).
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
		DATABASE_WEBHOOK_URL: process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
	});
});

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { ASAAS_EVENT_PAYMENT_CONFIRMED, ASAAS_EVENT_PAYMENT_RECEIVED, ASAAS_EVENT_PAYMENT_REFUNDED } from "@/lib/asaas/client";
import { buildFakePaymentEvent } from "@/lib/asaas/fake";
import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { captureOrder } from "@/lib/settlement/queries";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedBureauCost, seedCatalogItem, seedClientProfile, seedClientWalletTopup, seedTenant, seedWalletTopup, type SeededTenant } from "@/test/seed";

import { openOrder, placeOrder } from "./queries";
import type { OpenOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 6 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

const input: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

const PIX_FEE = "0.99";

async function newTenant(label: string) {
	const t = await seedTenant(owner, label);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await setSalePrice(t, "50.00");
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "200.00", createdBy: t.bureauAdmin.userId });
	return t;
}

async function setSalePrice(t: SeededTenant, salePrice: string) {
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice, salePricePerPartner: "0.00", updatedBy: t.bureauAdmin.userId });
}

async function seedCoupon(t: SeededTenant, i: { value: string; maxUses?: number }): Promise<string> {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, valid_from, active, created_by)
		 values ($1, $2, 'percent', $3, true, $4, now() - interval '1 hour', true, $5)`,
		[t.bureau.id, code, i.value, i.maxUses ?? null, t.bureauAdmin.userId],
	);
	return code;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });
const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

async function quote(t: SeededTenant) {
	const q = await quoteOrder(staff(t), "dossie_pf", { partnerCount: 0 });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

async function openOnlineOrder(identity: DbIdentity): Promise<string> {
	return withUserTransaction(identity, async (client) => {
		const opened = await openOrder(client, input);
		if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
		return opened.dossierId;
	});
}

type Setup = { t: SeededTenant; dossierId: string; chargeId: string; paymentId: string; price: number; total: number };

// Pedido online sem saldo, aguardando pagamento, com a cotação guardada e a cobrança Pix (preço + taxa) pendente.
async function setup(label: string, opts: { price?: string; couponCode?: string; tenant?: SeededTenant; client?: SeededTenant } = {}): Promise<Setup> {
	const t = opts.tenant ?? (await newTenant(label));
	const price = opts.price ?? "50.00";
	const dossierId = await openOnlineOrder(buyerOf(t));
	await owner.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price, coupon_code) values ($1, $2, $3, $4, $5)", [
		dossierId,
		t.bureau.id,
		t.client.userId,
		price,
		opts.couponCode ?? null,
	]);
	const paymentId = `pay_${randomBytes(8).toString("hex")}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into pix_charges (bureau_id, asaas_payment_id, amount, fee_amount, total_charged, status, pix_payload, expires_at, requested_by, client_profile_id, order_id, billing_type)
		 values ($1, $2, $3, $4, $3::numeric + $4::numeric, 'pending', 'pix-copia-e-cola-teste', now() + interval '30 minutes', $5, $5, $6, 'PIX') returning id`,
		[t.bureau.id, paymentId, price, PIX_FEE, t.client.userId, dossierId],
	);
	return { t, dossierId, chargeId: rows[0].id, paymentId, price: Number(price), total: Number(price) + Number(PIX_FEE) };
}

const pay = (s: Setup, o: { value?: number; eventId?: string; type?: string } = {}) =>
	applyAsaasPayment({
		eventId: o.eventId ?? randomUUID(),
		eventType: o.type ?? ASAAS_EVENT_PAYMENT_RECEIVED,
		asaasPaymentId: s.paymentId,
		payload: buildFakePaymentEvent({ eventId: "x", asaasPaymentId: s.paymentId, value: o.value ?? s.total }),
	});

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}
const orderState = async (id: string) => (await rows<{ state: string; state_reason: string | null }>("select state, state_reason from dossier_orders where dossier_id = $1", [id]))[0];
const wallet = async (t: SeededTenant) => (await rows("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId]))[0] as { available: string; reserved: string };
const topups = (t: SeededTenant) =>
	rows<{ amount: string; reference: string }>("select amount, reference from client_ledger_entries where client_profile_id = $1 and kind = 'topup' and idempotency_key like 'pix:%'", [t.client.userId]);
const settlements = (dossierId: string) => rows<{ id: string; status: string; price: string; coupon_id: string | null }>("select id, status, price, coupon_id from order_settlements where order_ref = $1", [dossierId]);
const chargeStatus = async (id: string) => (await rows<{ status: string }>("select status from pix_charges where id = $1", [id]))[0].status;
const audits = (action: string, recordId: string) => rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = $1 and record_id = $2", [action, recordId]);
const redemptionCount = async (t: SeededTenant) => Number((await rows<{ n: string }>("select count(*) as n from coupon_redemptions where bureau_id = $1", [t.bureau.id]))[0].n);

describe("order PIX webhook", () => {
	it("pays the order", async () => {
		const s = await setup("opw pays");
		const before = await wallet(s.t);

		expect(await pay(s)).toBe("order_paid");

		expect(await topups(s.t)).toEqual([{ amount: "50.00", reference: `pix_charge:${s.chargeId}` }]);
		expect(await settlements(s.dossierId)).toMatchObject([{ status: "reserved", price: "50.00" }]);
		expect(await wallet(s.t)).toEqual({ available: before.available, reserved: "50.00" });
		expect((await orderState(s.dossierId)).state).toBe("awaiting_authorization");
		expect(await chargeStatus(s.chargeId)).toBe("paid");
		const [settlement] = await settlements(s.dossierId);
		expect(await audits("wallet.topup", (await rows<{ id: string }>("select id from client_ledger_entries where reference = $1", [`pix_charge:${s.chargeId}`]))[0].id)).toHaveLength(1);
		expect(await audits("settlement.reserve", settlement.id)).toHaveLength(1);
		expect(await audits("order.pix_paid", s.chargeId)).toMatchObject([{ metadata: { result: "order_paid", amount: "50.00" } }]);
	});

	it("repeated event id is a duplicate", async () => {
		const s = await setup("opw repeat");
		const eventId = randomUUID();

		expect(await pay(s, { eventId })).toBe("order_paid");
		expect(await pay(s, { eventId })).toBe("duplicate");

		expect(await topups(s.t)).toHaveLength(1);
		expect(await settlements(s.dossierId)).toHaveLength(1);
	});

	it("RECEIVED then CONFIRMED pays once", async () => {
		const s = await setup("opw twice");

		expect(await pay(s, { type: ASAAS_EVENT_PAYMENT_RECEIVED })).toBe("order_paid");
		expect(await pay(s, { type: ASAAS_EVENT_PAYMENT_CONFIRMED })).toBe("duplicate");

		expect(await topups(s.t)).toHaveLength(1);
		expect(await settlements(s.dossierId)).toHaveLength(1);
	});

	it("two concurrent events with different ids pay once", async () => {
		const s = await setup("opw race");

		const results = await Promise.all([pay(s, { type: ASAAS_EVENT_PAYMENT_RECEIVED }), pay(s, { type: ASAAS_EVENT_PAYMENT_CONFIRMED })]);

		expect([...results].sort()).toEqual(["duplicate", "order_paid"]);
		expect(await topups(s.t)).toHaveLength(1);
		expect(await settlements(s.dossierId)).toHaveLength(1);
		expect((await wallet(s.t)).reserved).toBe("50.00");
	});

	it("lower value credits nothing", async () => {
		const s = await setup("opw lower");

		expect(await pay(s, { value: s.total - 0.01 })).toBe("amount_mismatch");

		expect(await chargeStatus(s.chargeId)).toBe("pending");
		expect(await topups(s.t)).toHaveLength(0);
		expect(await settlements(s.dossierId)).toHaveLength(0);
		expect((await orderState(s.dossierId)).state).toBe("awaiting_payment");
	});

	it("higher value credits the price", async () => {
		const s = await setup("opw higher");

		expect(await pay(s, { value: s.total + 5 })).toBe("order_paid");

		expect(await topups(s.t)).toMatchObject([{ amount: "50.00" }]);
		expect(await settlements(s.dossierId)).toMatchObject([{ price: "50.00" }]);
	});

	it("pays with the stored coupon and keeps the discount", async () => {
		const t = await newTenant("opw coupon");
		const code = await seedCoupon(t, { value: "20" });
		const s = await setup("opw coupon", { tenant: t, price: "40.00", couponCode: code });

		expect(await pay(s)).toBe("order_paid");

		expect(await topups(t)).toMatchObject([{ amount: "40.00" }]);
		const [settlement] = await settlements(s.dossierId);
		expect(settlement).toMatchObject({ status: "reserved", price: "40.00" });
		expect(settlement.coupon_id).not.toBeNull();
		expect(await redemptionCount(t)).toBe(1);
	});

	it("exhausted coupon after payment leaves balance", async () => {
		const t = await newTenant("opw exhausted");
		const code = await seedCoupon(t, { value: "20", maxUses: 1 });
		const s = await setup("opw exhausted", { tenant: t, price: "40.00", couponCode: code });
		// Outro pedido do mesmo cupom consome o único uso depois da abertura deste.
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.bureauAdmin.userId });
		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toMatchObject({ ok: true });
		const before = await wallet(t);
		const redemptions = await redemptionCount(t);

		expect(await pay(s)).toBe("order_reserve_failed");

		expect(Number((await wallet(t)).available)).toBe(Number(before.available) + 40);
		expect((await wallet(t)).reserved).toBe(before.reserved);
		expect(await settlements(s.dossierId)).toHaveLength(0);
		expect(await redemptionCount(t)).toBe(redemptions);
		expect((await orderState(s.dossierId)).state).toBe("awaiting_payment");
		expect(await audits("order.pix_paid", s.chargeId)).toMatchObject([{ metadata: { result: "order_reserve_failed", reason: "coupon_exhausted" } }]);
	});

	it("coupon works for a client blocked by attempts", async () => {
		const t = await newTenant("opw blocked");
		const code = await seedCoupon(t, { value: "20" });
		const s = await setup("opw blocked", { tenant: t, price: "40.00", couponCode: code });
		for (let i = 0; i < 10; i += 1) await owner.query("insert into coupon_attempt_misses (profile_id, bureau_id) values ($1, $2)", [t.client.userId, t.bureau.id]);

		expect(await pay(s)).toBe("order_paid");

		const [{ n }] = await rows<{ n: string }>("select count(*) as n from coupon_attempt_misses where profile_id = $1", [t.client.userId]);
		expect(Number(n)).toBe(10);
	});

	it("catalog price change after opening leaves balance", async () => {
		const s = await setup("opw catalog");
		// O preço do produto é global (055): volta a 50,00 no fim para não atropelar os outros arquivos.
		await setSalePrice(s.t, "60.00");
		try {
			expect(await pay(s)).toBe("order_reserve_failed");
		} finally {
			await setSalePrice(s.t, "50.00");
		}

		expect(await audits("order.pix_paid", s.chargeId)).toMatchObject([{ metadata: { reason: "price_mismatch" } }]);
		expect(await topups(s.t)).toMatchObject([{ amount: "50.00" }]);
		expect(await settlements(s.dossierId)).toHaveLength(0);
		expect((await orderState(s.dossierId)).state).toBe("awaiting_payment");
	});

	it("cancelled order keeps the money as balance", async () => {
		const s = await setup("opw cancelled");
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'payment_timeout' where dossier_id = $1", [s.dossierId]);
		const before = await wallet(s.t);

		expect(await pay(s)).toBe("order_not_payable");

		expect(Number((await wallet(s.t)).available)).toBe(Number(before.available) + 50);
		expect(await settlements(s.dossierId)).toHaveLength(0);
		expect((await orderState(s.dossierId)).state).toBe("cancelled");
	});

	it("late payment of an expired charge on a cancelled order becomes balance", async () => {
		const s = await setup("opw expired");
		await owner.query("update pix_charges set status = 'expired' where id = $1", [s.chargeId]);
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'payment_timeout' where dossier_id = $1", [s.dossierId]);

		expect(await pay(s)).toBe("order_not_payable");

		expect(await topups(s.t)).toMatchObject([{ amount: "50.00" }]);
		expect(await settlements(s.dossierId)).toHaveLength(0);
	});

	it("a cancelled charge credits nothing", async () => {
		const s = await setup("opw refused");
		await owner.query("update pix_charges set status = 'cancelled' where id = $1", [s.chargeId]);

		expect(await pay(s)).toBe("ignored");

		expect(await topups(s.t)).toHaveLength(0);
		expect(await settlements(s.dossierId)).toHaveLength(0);
	});

	it("a zero or sub-minimum price can never be quoted or charged", async () => {
		const t = await newTenant("opw zero");
		const dossierId = await openOnlineOrder(buyerOf(t));
		for (const price of ["0.00", "9.99"]) {
			await expect(
				owner.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price) values ($1, $2, $3, $4)", [dossierId, t.bureau.id, t.client.userId, price]),
			).rejects.toMatchObject({ code: "23514" });
		}
		await expect(setup("opw zero charge", { tenant: t, price: "0.00" })).rejects.toMatchObject({ code: "23514" });
	});

	it("restores the app context after the order branch", async () => {
		const s = await setup("opw context");
		const probe = "select coalesce(current_setting('app.user_id', true), '') as u, coalesce(current_setting('app.user_role', true), '') as r, coalesce(current_setting('app.bureau_id', true), '') as b, coalesce(current_setting('app.coupon_slot', true), '') as c";
		const c = await getWebhookPool().connect();
		try {
			await c.query("begin");
			const before = (await c.query(probe)).rows[0];
			const res = await c.query<{ result: string }>("select public.apply_asaas_payment($1, $2, $3, $4::jsonb) as result", [
				randomUUID(),
				ASAAS_EVENT_PAYMENT_RECEIVED,
				s.paymentId,
				JSON.stringify(buildFakePaymentEvent({ eventId: "x", asaasPaymentId: s.paymentId, value: s.total })),
			]);
			expect(res.rows[0].result).toBe("order_paid");
			expect((await c.query(probe)).rows[0]).toEqual(before);
		} finally {
			await c.query("rollback");
			c.release();
		}
	});

	it("restores the app context after a refused reservation with a coupon", async () => {
		const t = await newTenant("opw context coupon");
		const code = await seedCoupon(t, { value: "20", maxUses: 1 });
		const s = await setup("opw context coupon", { tenant: t, price: "40.00", couponCode: code });
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.bureauAdmin.userId });
		expect(await placeOrder(buyerOf(t), input, await quote(t), { couponCode: code })).toMatchObject({ ok: true });
		const probe = "select coalesce(current_setting('app.user_id', true), '') as u, coalesce(current_setting('app.coupon_slot', true), '') as c";
		const c = await getWebhookPool().connect();
		try {
			await c.query("begin");
			const before = (await c.query(probe)).rows[0];
			const res = await c.query<{ result: string }>("select public.apply_asaas_payment($1, $2, $3, $4::jsonb) as result", [
				randomUUID(),
				ASAAS_EVENT_PAYMENT_RECEIVED,
				s.paymentId,
				JSON.stringify(buildFakePaymentEvent({ eventId: "x", asaasPaymentId: s.paymentId, value: s.total })),
			]);
			expect(res.rows[0].result).toBe("order_reserve_failed");
			expect((await c.query(probe)).rows[0]).toEqual(before);
		} finally {
			await c.query("rollback");
			c.release();
		}
	});

	it("takes the coupon lock before crediting the wallet", async () => {
		const t = await newTenant("opw lock");
		const code = await seedCoupon(t, { value: "20" });
		const s = await setup("opw lock", { tenant: t, price: "40.00", couponCode: code });
		const [{ id: couponId }] = await rows<{ id: string }>("select id from coupons where bureau_id = $1 and code = $2", [t.bureau.id, code]);

		const holder = await owner.connect();
		try {
			await holder.query("begin");
			await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`coupon:${couponId}`]);
			const webhook = pay(s);
			// O webhook espera a trava do cupom.
			let waiting = false;
			for (let i = 0; i < 100 && !waiting; i += 1) {
				waiting = (await rows("select 1 from pg_locks where locktype = 'advisory' and not granted", [])).length > 0;
				if (!waiting) await new Promise((r) => setTimeout(r, 50));
			}
			expect(waiting).toBe(true);
			// Ainda não travou a carteira do cliente: outra conexão a trava sem esperar.
			const probe = await owner.connect();
			try {
				await probe.query("begin");
				const free = await probe.query("select 1 from client_wallets where client_profile_id = $1 for update skip locked", [t.client.userId]);
				expect(free.rows).toHaveLength(1);
			} finally {
				await probe.query("rollback");
				probe.release();
			}
			await holder.query("commit");
			expect(await webhook).toBe("order_paid");
		} finally {
			holder.release();
		}
		expect(await topups(t)).toHaveLength(1);
	});

	it("refund after reservation claws back on capture", async () => {
		const s = await setup("opw refund");
		expect(await pay(s)).toBe("order_paid");

		expect(await pay(s, { type: ASAAS_EVENT_PAYMENT_REFUNDED })).toBe("refunded");

		const result = await withUserTransaction(s.t.bureauAdmin, (c) => captureOrder(c, s.dossierId));
		expect(result).toMatchObject({ ok: true, status: "released", clawedBack: true });
	});

	it("affiliate commission on capture is unchanged", async () => {
		// Dois Bureaus iguais com indicado e afiliado: um paga com saldo, o outro por PIX.
		async function paired(label: string, viaPix: boolean) {
			const t = await newTenant(label);
			const affiliateId = (await seedClientProfile(owner, t.bureau.id)).userId;
			await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [t.client.userId, affiliateId, t.bureau.id]);
			await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, 10) on conflict (bureau_id) do update set default_pct = 10", [t.bureau.id]);
			const client = await owner.connect();
			try {
				await client.query("begin");
				await client.query("set local session_replication_role = replica");
				await client.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [t.client.userId]);
				await client.query("commit");
			} finally {
				client.release();
			}
			let dossierId: string;
			if (viaPix) {
				const s = await setup(label, { tenant: t });
				expect(await pay(s)).toBe("order_paid");
				dossierId = s.dossierId;
			} else {
				await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "50.00", createdBy: t.bureauAdmin.userId });
				const placed = await placeOrder(buyerOf(t), input, await quote(t));
				if (!placed.ok) throw new Error("placeOrder failed");
				dossierId = placed.dossierId;
			}
			expect(await withUserTransaction(t.bureauAdmin, (c) => captureOrder(c, dossierId))).toMatchObject({ ok: true, status: "captured" });
			return (
				await owner.query<{ pct: string; margin: string; amount: string; status: string }>(
					"select pct, margin, amount, status from affiliate_commissions where order_ref = $1",
					[dossierId],
				)
			).rows;
		}

		const byBalance = await paired("opw aff balance", false);
		const byPix = await paired("opw aff pix", true);

		expect(byBalance).toHaveLength(1);
		expect(byPix).toEqual(byBalance);
	});
});
