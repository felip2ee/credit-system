// Estorno do PIX do pedido antes da captura (066): apply_asaas_payment cancela o pedido que ainda não executa e libera a
// liquidação, contra um Postgres real, sob RLS. Preço de venda 50,00 e custo 1,00 (dossie_pf); taxa do PIX 0,99.
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

import { ASAAS_EVENT_PAYMENT_RECEIVED, ASAAS_EVENT_PAYMENT_REFUNDED } from "@/lib/asaas/client";
import { buildFakePaymentEvent } from "@/lib/asaas/fake";
import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { captureOrder } from "@/lib/settlement/queries";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedBureauCost, seedCatalogItem, seedClientWalletTopup, seedTenant, seedWalletTopup, type SeededTenant } from "@/test/seed";

import { completeOrder, openOrder, placeOrder } from "./queries";
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
const CHARGEBACK_REQUESTED = "PAYMENT_CHARGEBACK_REQUESTED";

async function newTenant(label: string) {
	const t = await seedTenant(owner, label);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice: "50.00", salePricePerPartner: "0.00", updatedBy: t.bureauAdmin.userId });
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "200.00", createdBy: t.bureauAdmin.userId });
	return t;
}

async function seedCoupon(t: SeededTenant, value: string): Promise<string> {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, valid_from, active, created_by)
		 values ($1, $2, 'percent', $3, true, null, now() - interval '1 hour', true, $4)`,
		[t.bureau.id, code, value, t.bureauAdmin.userId],
	);
	return code;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });

async function openOnlineOrder(identity: DbIdentity): Promise<string> {
	return withUserTransaction(identity, async (client) => {
		const opened = await openOrder(client, input);
		if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
		return opened.dossierId;
	});
}

type Setup = { t: SeededTenant; dossierId: string; chargeId: string; paymentId: string; total: number };

// Pedido online aguardando pagamento, com a cotação guardada e a cobrança Pix (preço + taxa) pendente.
async function setup(label: string, opts: { price?: string; couponCode?: string; tenant?: SeededTenant } = {}): Promise<Setup> {
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
	return { t, dossierId, chargeId: rows[0].id, paymentId, total: Number(price) + Number(PIX_FEE) };
}

const send = (s: Setup, type: string, eventId: string = randomUUID()) =>
	applyAsaasPayment({
		eventId,
		eventType: type,
		asaasPaymentId: s.paymentId,
		payload: buildFakePaymentEvent({ eventId: "x", asaasPaymentId: s.paymentId, value: s.total }),
	});
const pay = (s: Setup) => send(s, ASAAS_EVENT_PAYMENT_RECEIVED);
const refund = (s: Setup, eventId?: string) => send(s, ASAAS_EVENT_PAYMENT_REFUNDED, eventId);

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}
const orderRow = async (id: string) => (await rows<{ state: string; state_reason: string | null }>("select state, state_reason from dossier_orders where dossier_id = $1", [id]))[0];
const dossierStatus = async (id: string) => (await rows<{ status: string }>("select status from dossiers where id = $1", [id]))[0].status;
const consultationStatuses = async (id: string) => (await rows<{ status: string }>("select status from consultations where dossier_id = $1", [id])).map((r) => r.status);
const wallet = async (t: SeededTenant) => (await rows("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId]))[0] as { available: string; reserved: string };
const settlementStatus = async (id: string) => (await rows<{ status: string }>("select status from order_settlements where order_ref = $1", [id]))[0].status;
const chargeRow = async (id: string) => (await rows<{ status: string; refund_shortfall: string }>("select status, refund_shortfall from pix_charges where id = $1", [id]))[0];
const cancelAudits = (id: string) => rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = 'order.cancel' and record_id = $1", [id]);
const ledgerKinds = async (t: SeededTenant) =>
	(await rows<{ kind: string }>("select kind from client_ledger_entries where client_profile_id = $1 order by seq", [t.client.userId])).map((r) => r.kind);

// Conservação: disponível + reservado = recargas - estornos - capturas (reservar e liberar só movem entre os dois).
async function expectConserved(t: SeededTenant) {
	const [{ net }] = await rows<{ net: string }>(
		`select coalesce(sum(case kind when 'topup' then amount when 'reversal' then -amount when 'capture' then -amount else 0 end), 0) as net
		   from client_ledger_entries where client_profile_id = $1`,
		[t.client.userId],
	);
	const w = await wallet(t);
	expect(Number(w.available) + Number(w.reserved)).toBe(Number(net));
}

// awaiting_authorization -> ready (passo permitido pelo guard da 022).
const makeReady = (id: string) => owner.query("update dossier_orders set state = 'ready' where dossier_id = $1", [id]);

describe("order PIX refund before capture", () => {
	it("cancels an order awaiting authorization and releases the settlement", async () => {
		const s = await setup("opr auth");
		expect(await pay(s)).toBe("order_paid");
		expect((await orderRow(s.dossierId)).state).toBe("awaiting_authorization");

		expect(await refund(s)).toBe("refunded");

		expect(await orderRow(s.dossierId)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await settlementStatus(s.dossierId)).toBe("released");
		expect(await wallet(s.t)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await chargeRow(s.chargeId)).toEqual({ status: "refunded", refund_shortfall: "0.00" });
		expect(await dossierStatus(s.dossierId)).toBe("cancelled");
		expect(await consultationStatuses(s.dossierId)).toEqual(expect.arrayContaining(["rejected"]));
		expect((await consultationStatuses(s.dossierId)).every((x) => x === "rejected")).toBe(true);
		// O estorno já tirou o valor do reservado: a liberação não devolve nada à carteira.
		expect(await ledgerKinds(s.t)).toEqual(["topup", "reserve", "reversal"]);
		expect(await cancelAudits(s.dossierId)).toMatchObject([{ metadata: { reason: "payment_refunded", pix_charge_id: s.chargeId } }]);
		await expectConserved(s.t);
	});

	it("cancels a ready order", async () => {
		const s = await setup("opr ready");
		expect(await pay(s)).toBe("order_paid");
		await makeReady(s.dossierId);

		expect(await refund(s)).toBe("refunded");

		expect(await orderRow(s.dossierId)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await settlementStatus(s.dossierId)).toBe("released");
		expect(await wallet(s.t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(s.t);
	});

	it("an executing order keeps running and the capture claws back", async () => {
		const s = await setup("opr executing");
		expect(await pay(s)).toBe("order_paid");
		await makeReady(s.dossierId);
		await owner.query("update dossier_orders set state = 'executing' where dossier_id = $1", [s.dossierId]);

		expect(await refund(s)).toBe("refunded");

		expect((await orderRow(s.dossierId)).state).toBe("executing");
		expect(await settlementStatus(s.dossierId)).toBe("reserved");
		expect(await cancelAudits(s.dossierId)).toHaveLength(0);
		expect(await wallet(s.t)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await withUserTransaction(s.t.bureauAdmin, (c) => captureOrder(c, s.dossierId))).toMatchObject({ ok: true, status: "released", clawedBack: true });
		await expectConserved(s.t);
	});

	it("a repeated refund event changes nothing", async () => {
		const s = await setup("opr repeat");
		expect(await pay(s)).toBe("order_paid");
		const eventId = randomUUID();

		expect(await refund(s, eventId)).toBe("refunded");
		const after = { order: await orderRow(s.dossierId), wallet: await wallet(s.t), kinds: await ledgerKinds(s.t) };

		expect(await refund(s, eventId)).toBe("duplicate");
		expect(await send(s, ASAAS_EVENT_PAYMENT_REFUNDED)).toBe("duplicate");
		expect(await send(s, CHARGEBACK_REQUESTED)).toBe("duplicate");

		expect({ order: await orderRow(s.dossierId), wallet: await wallet(s.t), kinds: await ledgerKinds(s.t) }).toEqual(after);
		expect(await cancelAudits(s.dossierId)).toHaveLength(1);
		await expectConserved(s.t);
	});

	it("two concurrent refund events cancel once", async () => {
		const s = await setup("opr race");
		expect(await pay(s)).toBe("order_paid");

		const results = await Promise.all([refund(s), send(s, CHARGEBACK_REQUESTED)]);

		expect([...results].sort()).toEqual(["duplicate", "refunded"]);
		expect(await orderRow(s.dossierId)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await cancelAudits(s.dossierId)).toHaveLength(1);
		expect(await wallet(s.t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(s.t);
	});

	it("returns to the balance the part of the reservation the refund did not take", async () => {
		const t = await newTenant("opr other funds");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "30.00", createdBy: t.bureauAdmin.userId });
		const s = await setup("opr other funds", { tenant: t });
		expect(await pay(s)).toBe("order_paid");
		expect(await wallet(t)).toEqual({ available: "30.00", reserved: "50.00" });

		expect(await refund(s)).toBe("refunded");

		// O estorno de 50,00 tirou os 30,00 do saldo e 20,00 do reservado: os 30,00 que restam da reserva voltam ao saldo.
		expect(await orderRow(s.dossierId)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await settlementStatus(s.dossierId)).toBe("released");
		expect(await wallet(t)).toEqual({ available: "30.00", reserved: "0.00" });
		expect(await ledgerKinds(t)).toEqual(["topup", "topup", "reserve", "reversal", "release"]);
		await expectConserved(t);
	});

	it("keeps an order that other funds still fully back", async () => {
		const t = await newTenant("opr covered");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "50.00", createdBy: t.bureauAdmin.userId });
		const s = await setup("opr covered", { tenant: t });
		expect(await pay(s)).toBe("order_paid");

		expect(await refund(s)).toBe("refunded");

		// O estorno saiu do saldo do cliente; a reserva do pedido está inteira.
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "50.00" });
		expect((await orderRow(s.dossierId)).state).toBe("awaiting_authorization");
		expect(await settlementStatus(s.dossierId)).toBe("reserved");
		expect(await cancelAudits(s.dossierId)).toHaveLength(0);
		await expectConserved(t);
	});

	it("releases the coupon redemption with the order", async () => {
		const t = await newTenant("opr coupon");
		const code = await seedCoupon(t, "20");
		const s = await setup("opr coupon", { tenant: t, price: "40.00", couponCode: code });
		expect(await pay(s)).toBe("order_paid");
		expect(await rows("select status from coupon_redemptions where bureau_id = $1", [t.bureau.id])).toMatchObject([{ status: "reserved" }]);

		expect(await refund(s)).toBe("refunded");

		expect(await orderRow(s.dossierId)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await rows("select status from coupon_redemptions where bureau_id = $1", [t.bureau.id])).toMatchObject([{ status: "released" }]);
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("a refund of an order that was never reserved leaves it alone", async () => {
		const s = await setup("opr unpaid");
		expect(await refund(s)).toBe("ignored");

		expect((await orderRow(s.dossierId)).state).toBe("awaiting_payment");
		expect(await cancelAudits(s.dossierId)).toHaveLength(0);
	});
});

// Vários pedidos do mesmo cliente (067): o estorno do PIX cancela o pedido do PIX estornado, não o mais antigo, e só
// enquanto o reservado da carteira não cobre as liquidações vivas. Preço 50,00 salvo onde o PIX leva outro valor.
describe("order PIX refund with several orders of one client", () => {
	// Pedido pago com o saldo: recarrega o preço e abre; a reserva nasce na abertura.
	async function openWithBalance(t: SeededTenant, amount = "50.00"): Promise<string> {
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount, createdBy: t.bureauAdmin.userId });
		const q = await quoteOrder({ ...t.operator }, "dossie_pf", { partnerCount: 0 });
		if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
		const placed = await placeOrder(buyerOf(t), input, q);
		if (!placed.ok) throw new Error(`place failed: ${placed.reason}`);
		expect(placed.state).toBe("awaiting_authorization");
		return placed.dossierId;
	}
	// Pedido pago com PIX: abre sem saldo (aguarda o pagamento) e o evento de pagamento reserva.
	async function openWithPix(t: SeededTenant, couponPercent?: string): Promise<Setup> {
		const couponCode = couponPercent ? await seedCoupon(t, couponPercent) : undefined;
		const s = await setup("multi pix", { tenant: t, price: couponPercent ? "20.00" : "50.00", couponCode });
		expect(await pay(s)).toBe("order_paid");
		return s;
	}
	const stateOf = async (id: string) => (await orderRow(id)).state;
	const makeExecuting = async (id: string) => {
		await makeReady(id);
		await owner.query("update dossier_orders set state = 'executing' where dossier_id = $1", [id]);
	};
	const cancelled = { state: "cancelled", state_reason: "payment_refunded" };

	it("two orders: the refunded one cancels, the order paid with balance stays covered and captures", async () => {
		const t = await newTenant("multi two");
		const a = await openWithBalance(t);
		const b = await openWithPix(t);
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "100.00" });

		expect(await refund(b)).toBe("refunded");

		expect(await orderRow(b.dossierId)).toEqual(cancelled);
		expect(await settlementStatus(b.dossierId)).toBe("released");
		expect(await stateOf(a)).toBe("awaiting_authorization");
		expect(await settlementStatus(a)).toBe("reserved");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "50.00" });
		// O estorno já tirou o valor do reservado: nenhuma devolução, nenhum saldo negativo.
		expect(await ledgerKinds(t)).toEqual(["topup", "reserve", "topup", "reserve", "reversal"]);
		expect(await cancelAudits(a)).toHaveLength(0);
		expect(await cancelAudits(b.dossierId)).toHaveLength(1);
		await expectConserved(t);

		// Repetir o evento não muda nada.
		expect(await refund(b)).toBe("duplicate");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "50.00" });

		// O pedido A captura inteiro: não cai no clawback.
		expect(await withUserTransaction(t.bureauAdmin, (c) => captureOrder(c, a))).toMatchObject({ ok: true, status: "captured" });
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("three orders: only the refunded one in the middle cancels", async () => {
		const t = await newTenant("multi three");
		const a = await openWithBalance(t);
		const b = await openWithPix(t);
		const c = await openWithBalance(t);
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "150.00" });

		expect(await refund(b)).toBe("refunded");

		expect(await orderRow(b.dossierId)).toEqual(cancelled);
		expect(await stateOf(a)).toBe("awaiting_authorization");
		expect(await stateOf(c)).toBe("awaiting_authorization");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "100.00" });
		for (const id of [a, c]) {
			expect(await withUserTransaction(t.bureauAdmin, (cl) => captureOrder(cl, id))).toMatchObject({ ok: true, status: "captured" });
		}
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("own extra balance covers the refund and nothing cancels", async () => {
		const t = await newTenant("multi covered");
		const a = await openWithBalance(t);
		const b = await openWithPix(t);
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "50.00", createdBy: t.bureauAdmin.userId });
		expect(await wallet(t)).toEqual({ available: "50.00", reserved: "100.00" });

		expect(await refund(b)).toBe("refunded");

		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "100.00" });
		expect(await stateOf(a)).toBe("awaiting_authorization");
		expect(await stateOf(b.dossierId)).toBe("awaiting_authorization");
		expect(await cancelAudits(b.dossierId)).toHaveLength(0);
		await expectConserved(t);
	});

	it("order A already executing: the refunded order B cancels and A captures whole", async () => {
		const t = await newTenant("multi a executing");
		const a = await openWithBalance(t);
		await makeExecuting(a);
		const b = await openWithPix(t);

		expect(await refund(b)).toBe("refunded");

		expect(await orderRow(b.dossierId)).toEqual(cancelled);
		expect(await stateOf(a)).toBe("executing");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "50.00" });
		expect(await withUserTransaction(t.bureauAdmin, (c) => captureOrder(c, a))).toMatchObject({ ok: true, status: "captured" });
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("refunded order B already executing: the older order A (awaiting) cancels so that B captures whole", async () => {
		const t = await newTenant("multi b executing");
		const a = await openWithBalance(t);
		const b = await openWithPix(t);
		await makeExecuting(b.dossierId);

		expect(await refund(b)).toBe("refunded");

		expect(await orderRow(a)).toEqual(cancelled);
		expect(await settlementStatus(a)).toBe("released");
		expect(await stateOf(b.dossierId)).toBe("executing");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "50.00" });
		expect(await withUserTransaction(t.bureauAdmin, (c) => captureOrder(c, b.dossierId))).toMatchObject({ ok: true, status: "captured" });
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("keeps cancelling from the newest to the oldest while the reservation stays short", async () => {
		const t = await newTenant("multi cascade");
		const a = await openWithPix(t);
		const b = await openWithPix(t, "60");
		const c = await openWithPix(t, "60");
		await makeExecuting(a.dossierId);
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "90.00" });

		// A (50,00) estornado e já executando: reservado 40,00 para 90,00 de liquidações. C (a mais nova) e depois B cancelam.
		expect(await refund(a)).toBe("refunded");

		expect(await orderRow(c.dossierId)).toEqual(cancelled);
		expect(await orderRow(b.dossierId)).toEqual(cancelled);
		expect(await stateOf(a.dossierId)).toBe("executing");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "40.00" });
		// A reserva restante (40,00) não cobre A (50,00): o clawback da captura devolve os 40,00 ao saldo, sem negativo.
		expect(await withUserTransaction(t.bureauAdmin, (cl) => captureOrder(cl, a.dossierId))).toMatchObject({ ok: true, status: "released", clawedBack: true });
		expect(await wallet(t)).toEqual({ available: "40.00", reserved: "0.00" });
		await expectConserved(t);
	});

	it("stops cancelling as soon as the reservation covers the live orders", async () => {
		const t = await newTenant("multi stop");
		const a = await openWithBalance(t);
		const b = await openWithPix(t);
		const c = await openWithBalance(t);
		const d = await openWithBalance(t);
		await makeExecuting(b.dossierId);

		// B (50,00) estornado e executando: faltam 50,00. Só D (a mais nova) cancela; A e C seguem.
		expect(await refund(b)).toBe("refunded");

		expect(await orderRow(d)).toEqual(cancelled);
		expect(await stateOf(c)).toBe("awaiting_authorization");
		expect(await stateOf(a)).toBe("awaiting_authorization");
		expect(await wallet(t)).toEqual({ available: "0.00", reserved: "150.00" });
		await expectConserved(t);
	});

	it("an order refund never deadlocks with the tick closing the same order", async () => {
		const t = await newTenant("multi deadlock");
		const s = await openWithPix(t);
		await makeExecuting(s.dossierId);
		// X segura a carteira: o fechamento (T1) espera por ela depois de ter travado o que vem antes; o estorno (T2) chega depois.
		const x = await owner.connect();
		let t1: Promise<unknown> | undefined;
		let t2: Promise<unknown> | undefined;
		try {
			await x.query("begin");
			await x.query("select 1 from client_wallets where client_profile_id = $1 for update", [t.client.userId]);
			t1 = withUserTransaction(t.bureauAdmin, (c) => completeOrder(c, t.bureauAdmin, s.dossierId));
			const waiting = async (fn: string) =>
				Number(
					(await rows<{ n: string }>(
						"select count(*)::text as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1 and pid <> pg_backend_pid()",
						[`%${fn}%`],
					))[0].n,
				) > 0;
			const until = async (fn: string) => {
				for (let i = 0; i < 100 && !(await waiting(fn)); i++) await new Promise((r) => setTimeout(r, 50));
				expect(await waiting(fn)).toBe(true);
			};
			await until("capture_order");
			t2 = refund(s);
			await until("apply_asaas_payment");
		} finally {
			await x.query("rollback");
			x.release();
		}
		// Sem impasse (40P01): o fechamento termina primeiro (travou o pedido antes) e o estorno depois.
		expect(await t1).toBe("completed");
		expect(await t2).toBe("refunded");
		expect(await orderRow(s.dossierId)).toEqual({ state: "completed", state_reason: null });
		expect(await settlementStatus(s.dossierId)).toBe("captured");
		await expectConserved(t);
	});
});
