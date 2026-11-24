// Pix do link de pagamento e baixa pelo webhook do Asaas, contra um Postgres real, sob RLS. Asaas fake.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "i".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

// O Asaas fake por padrão; um teste troca o cliente por um que falha.
vi.mock("@/lib/asaas", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/asaas")>();
	return { ...original, getAsaasClient: vi.fn(original.getAsaasClient) };
});

import PaymentLinkPage from "@/app/pagar/[token]/page";
import { POST } from "@/app/api/webhooks/asaas/route";
import { getAsaasClient } from "@/lib/asaas";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import {
	buildFakePaymentEvent,
	createFakeAsaasClient,
	getFakeCancelledPayments,
	resetFakeCancelledPayments,
	resetFakeCustomers,
} from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedOrderDossier, seedTenant, type SeededTenant } from "@/test/seed";

import { registerCounterPayment } from "@/lib/counter-payments/queries";

import { getOrCreateLinkPixCharge } from "./pix";
import { createPaymentLink, resolvePaymentLink } from "./queries";

const TOKEN = "i".repeat(32);
const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let a: SeededTenant;
let b: SeededTenant;

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

const webhook = (payload: unknown) =>
	POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: TOKEN }),
			body: JSON.stringify(payload),
		}),
	);

// Pedido de balcão aguardando pagamento (preço 300) com um link ativo.
async function linkedOrder(t: SeededTenant, price = 300) {
	const orderId = randomUUID();
	await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
	await owner.query(
		"insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', $3, $4)",
		[orderId, t.bureau.id, price, Math.min(120, price - 1)],
	);
	await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
	const link = await createPaymentLink(t.bureauAdmin, orderId);
	if (!link.ok) throw new Error("expected link");
	const resolved = await resolvePaymentLink(link.token);
	if (!resolved.ok) throw new Error("expected resolved link");
	return { orderId, linkId: link.id, token: link.token, link: resolved.link };
}

const charges = async (linkId: string) =>
	(await owner.query("select * from pix_charges where payment_link_id = $1 order by created_at", [linkId])).rows;
const chargeCount = async (linkId: string) => (await charges(linkId)).length;
const orderState = async (orderId: string) =>
	(await owner.query("select state from dossier_orders where dossier_id = $1", [orderId])).rows[0].state as string;
const counterPayments = async (orderId: string) =>
	(await owner.query("select * from counter_payments where dossier_id = $1", [orderId])).rows;
const linkStatus = async (linkId: string) =>
	(await owner.query("select status from payment_links where id = $1", [linkId])).rows[0].status as string;
const walletMoney = async (t: SeededTenant) =>
	JSON.stringify([
		(await owner.query("select available, reserved from wallets where bureau_id = $1", [t.bureau.id])).rows,
		(await owner.query("select count(*)::int as n from ledger_entries where bureau_id = $1", [t.bureau.id])).rows,
		(await owner.query("select count(*)::int as n from client_ledger_entries where bureau_id = $1", [t.bureau.id])).rows,
		(await owner.query("select count(*)::int as n from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).rows,
	]);

const openPage = (token: string, pix = "1") => PaymentLinkPage({ params: { token }, searchParams: { pix } });

function payEvent(charge: { asaas_payment_id: string; external_reference: string }, value: number, eventId = randomUUID(), event?: string) {
	return buildFakePaymentEvent({
		eventId,
		asaasPaymentId: charge.asaas_payment_id,
		externalReference: charge.external_reference,
		value,
		event,
	});
}

beforeAll(async () => {
	a = await seedTenant(owner, "Pix Link A");
	b = await seedTenant(owner, "Pix Link B");
});

beforeEach(() => {
	resetFakeCancelledPayments();
	resetFakeCustomers();
	vi.mocked(getAsaasClient).mockReset();
	vi.mocked(getAsaasClient).mockImplementation(() => createFakeAsaasClient());
});

describe("página /pagar/<token>", () => {
	it("never creates a charge for an invalid, expired, cancelled or paid link", async () => {
		const spy = vi.mocked(getAsaasClient);
		await openPage("x".repeat(43));
		await openPage("short");

		const expired = await linkedOrder(a);
		await owner.query("update payment_links set expires_at = now() - interval '1 hour' where id = $1", [expired.linkId]);
		await openPage(expired.token);

		const cancelled = await linkedOrder(a);
		await owner.query("update payment_links set status = 'cancelled' where id = $1", [cancelled.linkId]);
		await openPage(cancelled.token);

		const paid = await linkedOrder(a);
		await owner.query("select payment_link_mark_paid($1)", [paid.orderId]).catch(() => undefined);
		await owner.query("update payment_links set status = 'paid', paid_at = now() where id = $1", [paid.linkId]);
		await openPage(paid.token);

		for (const l of [expired, cancelled, paid]) expect(await chargeCount(l.linkId)).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not create a charge on a plain open (link preview); only the click creates it", async () => {
		const o = await linkedOrder(a);
		await PaymentLinkPage({ params: { token: o.token }, searchParams: {} });
		expect(await chargeCount(o.linkId)).toBe(0);
		await openPage(o.token);
		expect(await chargeCount(o.linkId)).toBe(1);
	});

	it("does not create a charge when the order is no longer awaiting payment", async () => {
		const o = await linkedOrder(a);
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'cancelled_by_staff' where dossier_id = $1", [o.orderId]);
		expect(await getOrCreateLinkPixCharge(o.linkId)).toEqual({ ok: false, reason: "unavailable" });
		expect(await chargeCount(o.linkId)).toBe(0);
	});
});

describe("cobrança Pix do link", () => {
	it("reuses the pending charge: two opens, in parallel too, make ONE charge for the order price", async () => {
		const o = await linkedOrder(a);
		const first = await getOrCreateLinkPixCharge(o.linkId);
		const [second, third] = await Promise.all([getOrCreateLinkPixCharge(o.linkId), getOrCreateLinkPixCharge(o.linkId)]);
		if (!first.ok) throw new Error("expected ok");
		expect(second.ok && second.pixPayload).toBe(first.pixPayload);
		expect([second, third].every((r) => r.ok || r.reason === "in_progress")).toBe(true);

		const rows = await charges(o.linkId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			bureau_id: a.bureau.id,
			client_profile_id: null,
			billing_type: "PIX",
			status: "pending",
			amount: "300.00",
			total_charged: null,
		});
		expect(first.qrDataUrl).toMatch(/^data:image\/png;base64,/);
		const ttlMin = (rows[0].expires_at.getTime() - Date.now()) / 60_000;
		expect(ttlMin).toBeGreaterThan(29);
		expect(ttlMin).toBeLessThanOrEqual(30);
		expect(rows[0].asaas_payment_id).toBeTruthy();
	});

	it("replaces a charge that expired and keeps one pending", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		await owner.query("update pix_charges set expires_at = now() - interval '1 minute' where payment_link_id = $1", [o.linkId]);
		const next = await getOrCreateLinkPixCharge(o.linkId);
		expect(next.ok).toBe(true);
		const rows = await charges(o.linkId);
		expect(rows.map((r) => r.status)).toEqual(["expired", "pending"]);
	});

	it("does not show link charges in the Bureau wallet screens", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const { listPixCharges, countPendingPixCharges } = await import("@/lib/wallet/pix-charges");
		const seen = await withUserTransaction(a.bureauAdmin, async (client) => ({
			list: await listPixCharges(client, a.bureau.id),
			pending: await countPendingPixCharges(client, a.bureau.id),
		}));
		const linkIds = (await owner.query("select id from pix_charges where payment_link_id is not null and bureau_id = $1", [a.bureau.id])).rows.map((r) => r.id);
		expect(seen.list.some((c) => linkIds.includes(c.id))).toBe(false);
		expect(seen.pending).toBe(0);
	});

	it("leaves no pending ghost when Asaas fails, and the next open works", async () => {
		const o = await linkedOrder(a);
		vi.mocked(getAsaasClient).mockImplementationOnce(() => ({
			...createFakeAsaasClient(),
			createPixCharge: () => Promise.reject(new Error("asaas down")),
		}));
		expect(await getOrCreateLinkPixCharge(o.linkId)).toEqual({ ok: false, reason: "failed" });
		expect((await charges(o.linkId)).map((r) => r.status)).toEqual(["cancelled"]);

		const retry = await getOrCreateLinkPixCharge(o.linkId);
		expect(retry.ok).toBe(true);
		expect((await charges(o.linkId)).map((r) => r.status)).toEqual(["cancelled", "pending"]);
	});

	it("caps creations: 5 charges per link per hour", async () => {
		const o = await linkedOrder(a);
		for (let i = 0; i < 5; i += 1) {
			vi.mocked(getAsaasClient).mockImplementationOnce(() => ({
				...createFakeAsaasClient(),
				createPixCharge: () => Promise.reject(new Error("asaas down")),
			}));
			await getOrCreateLinkPixCharge(o.linkId);
		}
		expect(await getOrCreateLinkPixCharge(o.linkId)).toEqual({ ok: false, reason: "rate_limited" });
		expect(await chargeCount(o.linkId)).toBe(5);
	});

	it("refuses a price outside the Pix charge limits", async () => {
		// createPaymentLink já recusa esse valor (L-D): o link de um pedido barato é inserido direto, como se fosse antigo.
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: a.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 5, 4)", [orderId, a.bureau.id]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await owner.query<{ id: string }>(
			`insert into payment_links (bureau_id, order_id, token_hash, expires_at, created_by)
			 values ($1, $2, $3, now() + interval '1 day', $4) returning id`,
			[a.bureau.id, orderId, randomUUID().replace(/-/g, "").repeat(2), a.bureauAdmin.userId],
		);
		expect(await getOrCreateLinkPixCharge(link.rows[0].id)).toEqual({ ok: false, reason: "amount_out_of_range" });
		expect(await chargeCount(link.rows[0].id)).toBe(0);
	});

	it("keeps another bureau out: its staff cannot read the charge or the counter payment", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await webhook(payEvent(row, 300));
		const seen = await withUserTransaction(b.bureauAdmin, async (client) => ({
			charges: (await client.query("select id from pix_charges where payment_link_id = $1", [o.linkId])).rows,
			payments: (await client.query("select id from counter_payments where dossier_id = $1", [o.orderId])).rows,
			links: (await client.query("select id from payment_links where id = $1", [o.linkId])).rows,
		}));
		expect(seen).toEqual({ charges: [], payments: [], links: [] });
		const own = await withUserTransaction(a.bureauAdmin, (client) =>
			client.query("select id from counter_payments where dossier_id = $1", [o.orderId]),
		);
		expect(own.rows).toHaveLength(1);
	});
});

describe("webhook do Asaas para cobrança de link", () => {
	it("paid: marks the link paid, inserts ONE pix counter payment and advances the order; no wallet credit", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const before = await walletMoney(a);

		const res = await webhook(payEvent(row, 300));
		expect(res.status).toBe(200);

		expect(await linkStatus(o.linkId)).toBe("paid");
		const payments = await counterPayments(o.orderId);
		expect(payments).toHaveLength(1);
		expect(payments[0]).toMatchObject({ method: "pix", amount: "300.00", pix_charge_id: row.id, bureau_id: a.bureau.id });
		// Sem autorização SCR concedida: pago, então aguarda a autorização.
		expect(await orderState(o.orderId)).toBe("awaiting_authorization");
		expect((await charges(o.linkId))[0].status).toBe("paid");
		expect(await walletMoney(a)).toBe(before);
		const event = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1", [row.asaas_payment_id])).rows;
		expect(event.map((e) => e.result)).toEqual(["link_paid"]);
		const audit = JSON.stringify((await owner.query("select metadata from audit_logs where action = 'payment_link.paid' and record_id = $1", [row.id])).rows);
		expect(audit).not.toContain(o.token);
		// Aberta de novo depois de paga: tela neutra, sem cobrança nova.
		await openPage(o.token);
		expect(await chargeCount(o.linkId)).toBe(1);
	});

	it("goes straight to ready when the SCR authorization (deps channel) is already granted", async () => {
		const o = await linkedOrder(a);
		await owner.query(
			`with s as (
			   insert into scr_authorizations (bureau_id, document, type, holder_id, status, authorized_at, expires_at, channel)
			   select d.bureau_id, '00000000000', 'PF', d.holder_id, 'authorized', now(), now() + interval '30 days', 'deps'
			     from dossiers d where d.id = $1 returning id)
			 update consultations set scr_authorization_id = (select id from s) where dossier_id = $1`,
			[o.orderId],
		);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await webhook(payEvent(row, 300));
		expect(await orderState(o.orderId)).toBe("ready");
	});

	it("delivered twice (same event, and RECEIVED after CONFIRMED) still makes one counter payment", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const eventId = randomUUID();
		await webhook(payEvent(row, 300, eventId, "PAYMENT_CONFIRMED"));
		await webhook(payEvent(row, 300, eventId, "PAYMENT_CONFIRMED"));
		await webhook(payEvent(row, 300, randomUUID(), "PAYMENT_RECEIVED"));
		await Promise.all([webhook(payEvent(row, 300, randomUUID())), webhook(payEvent(row, 300, randomUUID()))]);
		expect(await counterPayments(o.orderId)).toHaveLength(1);
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1 order by received_at", [row.asaas_payment_id])).rows.map((r) => r.result);
		expect(results.filter((r) => r === "link_paid")).toHaveLength(1);
		expect(results.every((r) => r === "link_paid" || r === "link_duplicate")).toBe(true);
	});

	it.each([299.99, 300.01, 150])("wrong amount %s: order does not advance, link stays active, charge stays pending", async (value) => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const before = await walletMoney(a);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const res = await webhook(payEvent(row, value));
		expect(res.status).toBe(200);
		expect(await orderState(o.orderId)).toBe("awaiting_payment");
		expect(await counterPayments(o.orderId)).toHaveLength(0);
		expect(await linkStatus(o.linkId)).toBe("active");
		expect((await charges(o.linkId))[0].status).toBe("pending");
		expect(await walletMoney(a)).toBe(before);
		// O log traz o id do pagamento, nunca documento nem token.
		expect(JSON.stringify(error.mock.calls)).not.toContain(o.token);
		error.mockRestore();
		// O valor certo depois ainda baixa.
		await webhook(payEvent(row, 300));
		expect(await counterPayments(o.orderId)).toHaveLength(1);
	});

	it("a payment without a numeric value does not advance the order", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const event = payEvent(row, 300);
		delete (event.payment as { value?: number }).value;
		await webhook(event);
		expect(await counterPayments(o.orderId)).toHaveLength(0);
		expect(await orderState(o.orderId)).toBe("awaiting_payment");
	});

	it("a refund event on a paid link charge touches no wallet, payable or order state", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await webhook(payEvent(row, 300));
		const before = await walletMoney(a);
		const state = await orderState(o.orderId);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const res = await webhook(payEvent(row, 300, randomUUID(), "PAYMENT_REFUNDED"));
		expect(res.status).toBe(200);
		expect(error).toHaveBeenCalledWith("[asaas-webhook] estorno de pix de link sem tratamento", {
			event: "PAYMENT_REFUNDED",
			asaasPaymentId: row.asaas_payment_id,
		});
		error.mockRestore();
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1 order by received_at", [row.asaas_payment_id])).rows.map((r) => r.result);
		expect(results).toEqual(["link_paid", "link_refund_ignored"]);
		expect(await walletMoney(a)).toBe(before);
		expect(await orderState(o.orderId)).toBe(state);
		expect((await charges(o.linkId))[0].status).toBe("paid");
	});

	it("pays a charge the app had cancelled after an Asaas failure of unknown outcome (found by external reference)", async () => {
		const o = await linkedOrder(a);
		vi.mocked(getAsaasClient).mockImplementationOnce(() => ({
			...createFakeAsaasClient(),
			createPixCharge: () => Promise.reject(new Error("timeout")),
		}));
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		expect(row.status).toBe("cancelled");
		await webhook(
			buildFakePaymentEvent({ eventId: randomUUID(), asaasPaymentId: `pay_late_${randomUUID()}`, externalReference: row.external_reference, value: 300 }),
		);
		expect(await counterPayments(o.orderId)).toHaveLength(1);
		expect(await linkStatus(o.linkId)).toBe("paid");
	});

	it("order paid elsewhere meanwhile: money arrived but no counter payment is added", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'cancelled_by_staff' where dossier_id = $1", [o.orderId]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300));
		error.mockRestore();
		expect(await counterPayments(o.orderId)).toHaveLength(0);
		expect(await orderState(o.orderId)).toBe("cancelled");
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1", [row.asaas_payment_id])).rows;
		expect(results.map((r) => r.result)).toEqual(["link_order_not_payable"]);
	});

	it("a normal wallet charge still credits (no regression)", async () => {
		const { seedPixCharge } = await import("@/test/seed");
		const charge = await seedPixCharge(owner, { bureauId: a.bureau.id, requestedBy: a.bureauAdmin.userId, amount: "100.00" });
		const before = JSON.parse(await walletMoney(a))[0][0].available;
		await webhook(buildFakePaymentEvent({ eventId: randomUUID(), asaasPaymentId: charge.asaasPaymentId, value: 100 }));
		const after = (await owner.query("select available from wallets where bureau_id = $1", [a.bureau.id])).rows[0].available;
		expect(Number(after) - Number(before)).toBe(100);
	});
});

// Pagamento de balcão já lançado (sem avançar o pedido), como um pagamento parcial em dinheiro.
const addCounterPayment = (t: SeededTenant, orderId: string, amount: number, voided = false) =>
	owner.query(
		`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by, voided_at, voided_by, void_reason)
		 values ($1, $2, 'cash', $3, $4, $5, $6, $7)`,
		[t.bureau.id, orderId, amount, t.bureauAdmin.userId, voided ? new Date() : null, voided ? t.bureauAdmin.userId : null, voided ? "teste" : null],
	);

describe("pagamento parcial no balcão (H1)", () => {
	it("charges only what is left, and the webhook for that amount advances the order", async () => {
		const o = await linkedOrder(a);
		await addCounterPayment(a, o.orderId, 100);
		const res = await getOrCreateLinkPixCharge(o.linkId);
		expect(res.ok && res.amount).toBe("200.00");
		const [row] = await charges(o.linkId);
		expect(row.amount).toBe("200.00");

		await webhook(payEvent(row, 200));
		const payments = await counterPayments(o.orderId);
		expect(payments.map((p) => p.amount).sort()).toEqual(["100.00", "200.00"]);
		expect(await orderState(o.orderId)).toBe("awaiting_authorization");
		expect(await linkStatus(o.linkId)).toBe("paid");
	});

	it("ignores voided payments and applies the Pix amount range to what is left", async () => {
		const voided = await linkedOrder(a);
		await addCounterPayment(a, voided.orderId, 100, true);
		const full = await getOrCreateLinkPixCharge(voided.linkId);
		expect(full.ok && full.amount).toBe("300.00");

		const small = await linkedOrder(a);
		await addCounterPayment(a, small.orderId, 295);
		expect(await getOrCreateLinkPixCharge(small.linkId)).toEqual({ ok: false, reason: "amount_out_of_range" });

		const covered = await linkedOrder(a);
		await addCounterPayment(a, covered.orderId, 300);
		expect(await getOrCreateLinkPixCharge(covered.linkId)).toEqual({ ok: false, reason: "unavailable" });
		expect(await chargeCount(small.linkId)).toBe(0);
		expect(await chargeCount(covered.linkId)).toBe(0);
	});

	it("a counter payment added after the charge: the Pix is still booked (money never left unbooked), the order advances, overpaid is flagged", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await addCounterPayment(a, o.orderId, 50);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300));
		expect(error).toHaveBeenCalledWith("[asaas-webhook] pix de link maior que o saldo da consulta", {
			asaasPaymentId: row.asaas_payment_id,
		});
		error.mockRestore();

		expect((await counterPayments(o.orderId)).map((p) => p.amount).sort()).toEqual(["300.00", "50.00"]);
		expect(await orderState(o.orderId)).toBe("awaiting_authorization");
		expect(await linkStatus(o.linkId)).toBe("paid");
		expect((await charges(o.linkId))[0].status).toBe("paid");
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1", [row.asaas_payment_id])).rows;
		expect(results.map((r) => r.result)).toEqual(["link_overpaid"]);
		// Sem segundo Pix: o link está pago e o pedido não aguarda pagamento.
		expect(await getOrCreateLinkPixCharge(o.linkId)).toEqual({ ok: false, reason: "unavailable" });
	});

	it("a redelivery of the overpaid Pix (same event and a new event id) books ONE counter payment", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await addCounterPayment(a, o.orderId, 50);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const eventId = randomUUID();
		await webhook(payEvent(row, 300, eventId));
		await webhook(payEvent(row, 300, eventId));
		await webhook(payEvent(row, 300, randomUUID(), "PAYMENT_CONFIRMED"));
		error.mockRestore();
		const pix = (await counterPayments(o.orderId)).filter((p) => p.pix_charge_id !== null);
		expect(pix).toHaveLength(1);
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1 order by received_at", [row.asaas_payment_id])).rows.map((r) => r.result);
		expect(results[0]).toBe("link_overpaid");
		expect(results.slice(1).every((r) => r === "link_duplicate" || r === "duplicate")).toBe(true);
	});

	it("a counter payment voided after the reserve: the Pix of the reserved amount is booked, the order keeps waiting and the link stays active", async () => {
		const o = await linkedOrder(a);
		await addCounterPayment(a, o.orderId, 100);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		expect(row.amount).toBe("200.00");
		await owner.query("update counter_payments set voided_at = now(), voided_by = $2, void_reason = 'teste' where dossier_id = $1", [o.orderId, a.bureauAdmin.userId]);
		await webhook(payEvent(row, 200));

		expect((await counterPayments(o.orderId)).filter((p) => p.voided_at === null).map((p) => p.amount)).toEqual(["200.00"]);
		expect(await orderState(o.orderId)).toBe("awaiting_payment");
		expect(await linkStatus(o.linkId)).toBe("active");
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1", [row.asaas_payment_id])).rows;
		expect(results.map((r) => r.result)).toEqual(["link_paid"]);
		const next = await getOrCreateLinkPixCharge(o.linkId);
		expect(next.ok && next.amount).toBe("100.00");
	});

	it("a Pix of the exact remainder after a partial cash payment still pays the link and the order", async () => {
		const o = await linkedOrder(a);
		await addCounterPayment(a, o.orderId, 100);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await webhook(payEvent(row, 200));
		expect(await orderState(o.orderId)).toBe("awaiting_authorization");
		expect(await linkStatus(o.linkId)).toBe("paid");
	});

	it("webhook and cash register at the same time never double-book: the sum is the price and one side is refused or flagged", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const [, cash] = await Promise.all([
			webhook(payEvent(row, 300)),
			registerCounterPayment(a.bureauAdmin, { dossierId: o.orderId, method: "cash", amount: "300.00", note: null, receivedAt: new Date() }),
		]);
		error.mockRestore();
		const live = (await counterPayments(o.orderId)).filter((p) => p.voided_at === null);
		expect(live.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(300);
		expect(live).toHaveLength(1);
		if (!cash.ok) expect(cash.reason).toBe("order_not_payable");
		expect(await orderState(o.orderId)).toBe("awaiting_authorization");
	});

	it("order already fully paid at the counter: the Pix that arrives is flagged link_order_not_payable, not mismatch", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await addCounterPayment(a, o.orderId, 300);
		await owner.query("update dossier_orders set state = 'awaiting_authorization' where dossier_id = $1", [o.orderId]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300));
		error.mockRestore();
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1", [row.asaas_payment_id])).rows;
		expect(results.map((r) => r.result)).toEqual(["link_order_not_payable"]);
		expect(await counterPayments(o.orderId)).toHaveLength(1);
	});
});

describe("Pix antigo cancelado no Asaas (M1)", () => {
	it("cancels the old payment when the charge is rotated", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [old] = await charges(o.linkId);
		await owner.query("update pix_charges set expires_at = now() - interval '1 minute' where id = $1", [old.id]);
		expect((await getOrCreateLinkPixCharge(o.linkId)).ok).toBe(true);
		expect(getFakeCancelledPayments()).toEqual([old.asaas_payment_id]);
	});

	it("a failing cancel never blocks the new charge", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [old] = await charges(o.linkId);
		await owner.query("update pix_charges set expires_at = now() - interval '1 minute' where id = $1", [old.id]);
		vi.mocked(getAsaasClient).mockImplementation(() => ({
			...createFakeAsaasClient(),
			cancelPixCharge: () => Promise.reject(new Error("asaas down")),
		}));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await getOrCreateLinkPixCharge(o.linkId)).ok).toBe(true);
		expect(error).toHaveBeenCalledWith("[payment-link-pix] falhou ao cancelar Pix antigo no Asaas", {
			asaasPaymentId: old.asaas_payment_id,
			name: "Error",
		});
		error.mockRestore();
		expect((await charges(o.linkId)).map((r) => r.status)).toEqual(["expired", "pending"]);
	});

	it("cancels the open Pix of a link that gets replaced, and the old Pix, if paid anyway, is still booked", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [old] = await charges(o.linkId);
		const next = await createPaymentLink(a.bureauAdmin, o.orderId);
		if (!next.ok) throw new Error("expected link");
		expect(getFakeCancelledPayments()).toEqual([old.asaas_payment_id]);

		await webhook(payEvent(old, 300));
		expect(await counterPayments(o.orderId)).toHaveLength(1);
		expect(await linkStatus(next.id)).toBe("paid");
	});

	it("a failing cancel does not block the replacement link", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		vi.mocked(getAsaasClient).mockImplementation(() => ({
			...createFakeAsaasClient(),
			cancelPixCharge: () => Promise.reject(new Error("asaas down")),
		}));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await createPaymentLink(a.bureauAdmin, o.orderId)).ok).toBe(true);
		error.mockRestore();
	});
});

describe("estorno de Pix de link (M2)", () => {
	it("refund before RECEIVED: the charge becomes refunded and the late RECEIVED does not advance the order", async () => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300, randomUUID(), "PAYMENT_REFUNDED"));
		expect((await charges(o.linkId))[0].status).toBe("refunded");
		await webhook(payEvent(row, 300));
		error.mockRestore();

		expect(await counterPayments(o.orderId)).toHaveLength(0);
		expect(await orderState(o.orderId)).toBe("awaiting_payment");
		expect(await linkStatus(o.linkId)).toBe("active");
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1 order by received_at", [row.asaas_payment_id])).rows.map((r) => r.result);
		expect(results).toEqual(["link_refund_ignored", "link_duplicate"]);
	});

	it.each(["expired", "cancelled"])("refund before RECEIVED on a %s charge (already rotated): the late RECEIVED does not book the order (L-B)", async (status) => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await owner.query("update pix_charges set status = $2 where id = $1", [row.id, status]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300, randomUUID(), "PAYMENT_REFUNDED"));
		expect((await charges(o.linkId))[0].status).toBe("refunded");
		await webhook(payEvent(row, 300));
		error.mockRestore();

		expect(await counterPayments(o.orderId)).toHaveLength(0);
		expect(await orderState(o.orderId)).toBe("awaiting_payment");
		const results = (await owner.query("select result from asaas_webhook_events where asaas_payment_id = $1 order by received_at", [row.asaas_payment_id])).rows.map((r) => r.result);
		expect(results).toEqual(["link_refund_ignored", "link_duplicate"]);
	});

	it.each(["PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"])("%s on a paid charge is logged and changes nothing", async (event) => {
		const o = await linkedOrder(a);
		await getOrCreateLinkPixCharge(o.linkId);
		const [row] = await charges(o.linkId);
		await webhook(payEvent(row, 300));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await webhook(payEvent(row, 300, randomUUID(), event));
		expect(error).toHaveBeenCalledWith("[asaas-webhook] estorno de pix de link sem tratamento", {
			event,
			asaasPaymentId: row.asaas_payment_id,
		});
		error.mockRestore();
		expect((await charges(o.linkId))[0].status).toBe("paid");
		expect(await counterPayments(o.orderId)).toHaveLength(1);
	});
});

describe("cliente Asaas do pagador (L4)", () => {
	it("reuses the Asaas customer across charges of the same holder, keyed by holder id", async () => {
		const o = await linkedOrder(a);
		const fake = createFakeAsaasClient();
		const createCustomer = vi.fn(fake.createCustomer);
		vi.mocked(getAsaasClient).mockImplementation(() => ({ ...fake, createCustomer }));
		await getOrCreateLinkPixCharge(o.linkId);
		await owner.query("update pix_charges set expires_at = now() - interval '1 minute' where payment_link_id = $1", [o.linkId]);
		await getOrCreateLinkPixCharge(o.linkId);

		expect(await chargeCount(o.linkId)).toBe(2);
		expect(createCustomer).toHaveBeenCalledTimes(1);
		const holder = (await owner.query("select d.holder_id from dossiers d where d.id = $1", [o.orderId])).rows[0].holder_id;
		expect(createCustomer.mock.calls[0][0].externalReference).toBe(`holder:${holder}`);
	});
});
