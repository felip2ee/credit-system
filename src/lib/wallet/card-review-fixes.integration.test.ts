// Correções da revisão do cartão (migration 043): chargeback, conferência do valor pago, corrida do bind, nota por
// parcelamento e contagens de tentativas. Roda contra um Postgres real, sob RLS, pela rota pública do webhook.

import { randomInt, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system_test",
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
			process.env.TEST_DATABASE_WEBHOOK_URL ??
			"postgres://app_webhook:test@localhost:54329/credit_system_test",
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
// A nota fica fora destes testes: a rota a agenda depois da resposta.
vi.mock("@/lib/nfse/invoice", async () => {
	const actual = await vi.importActual<typeof import("@/lib/nfse/invoice")>("@/lib/nfse/invoice");
	return {
		...actual,
		requestInvoiceForPayment: vi.fn().mockResolvedValue("not_requested"),
		repairInvoiceForPayment: vi.fn().mockResolvedValue("not_requested"),
	};
});

import { POST } from "@/app/api/webhooks/asaas/route";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { findNfseChargeByPayment } from "@/lib/nfse/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedTenant } from "@/test/seed";

import {
	bindAsaasCharge,
	countPendingClientPixCharges,
	countPendingPixCharges,
	countRecentCardAttemptsByBureau,
	countRecentCardAttemptsByIp,
	MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR,
	MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR,
	reserveCharge,
	type ChargeScope,
} from "./pix-charges";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "i".repeat(32);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

type Payment = Record<string, unknown>;

// Corpo do evento como o Asaas manda.
async function send(event: string, paymentId: string, payment: Payment = {}): Promise<{ result: string; eventId: string }> {
	const eventId = `evt_${randomUUID()}`;
	const response = await POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: TOKEN }),
			body: JSON.stringify({ id: eventId, event, payment: { object: "payment", id: paymentId, ...payment } }),
		}),
	);
	expect(response.status).toBe(200);
	const { rows } = await owner.query<{ result: string }>("select result from asaas_webhook_events where event_id = $1", [eventId]);
	return { result: rows[0].result, eventId };
}

const clientBalance = async (id: string) =>
	(await owner.query<{ available: string }>("select available from client_wallets where client_profile_id = $1", [id])).rows[0].available;
const chargeRow = async (id: string) =>
	(
		await owner.query(
			"select status, asaas_payment_id, asaas_installment_id, card_brand, card_last4, refund_shortfall from pix_charges where id = $1",
			[id],
		)
	).rows[0];

type Reserve = {
	billing?: "PIX" | "CREDIT_CARD";
	installments?: number;
	total?: string | null;
	fee?: string;
	ip?: string | null;
};

// Reserva uma cobrança de R$ 100,00 (cartão: taxa 6,50 e total 106,50 por padrão).
async function reserve(identity: DbIdentity, scope: ChargeScope, options: Reserve = {}) {
	const billing = options.billing ?? "PIX";
	const row = await withUserTransaction(identity, (c) =>
		reserveCharge(c, identity, {
			scope,
			externalReference: randomUUID(),
			amount: "100.00",
			billingType: billing,
			installments: options.installments ?? 1,
			feeAmount: billing === "PIX" ? "0.00" : (options.fee ?? "6.50"),
			totalCharged: billing === "PIX" ? null : options.total === undefined ? "106.50" : options.total,
			payerKind: "owner",
			payerDocumentMasked: "***.456.***-**",
			requestIp: options.ip,
		}),
	);
	if (!row.ok) throw new Error("not reserved");
	return row.id;
}

async function externalReference(id: string): Promise<string> {
	return (await owner.query<{ external_reference: string }>("select external_reference from pix_charges where id = $1", [id])).rows[0]
		.external_reference;
}

// Cobrança do cliente ligada ao Asaas (Pix ou cartão), pronta para receber eventos.
async function bound(label: string, options: Reserve = {}) {
	const tenant = await seedTenant(owner, label);
	const clientId = tenant.client.userId;
	const id = await reserve(tenant.client, { kind: "client", clientProfileId: clientId }, options);
	const paymentId = `pay_${randomUUID()}`;
	const installment = (options.installments ?? 1) > 1 ? `ins_${randomUUID()}` : null;
	await withUserTransaction(tenant.client, (c) =>
		bindAsaasCharge(c, id, {
			asaasPaymentId: paymentId,
			pixPayload: options.billing === "CREDIT_CARD" ? undefined : "000201x",
			asaasInstallmentId: installment,
		}),
	);
	return { tenant, clientId, id, paymentId, installment };
}

describe("chargeback (043)", () => {
	it("PAYMENT_CHARGEBACK_REQUESTED reverses the credit like a refund, once, and a later refund is a duplicate", async () => {
		const c = await bound("Cb A");
		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 100 })).result).toBe("credited");
		expect(await clientBalance(c.clientId)).toBe("100.00");

		expect((await send("PAYMENT_CHARGEBACK_REQUESTED", c.paymentId, { value: 100 })).result).toBe("refunded");
		expect(await clientBalance(c.clientId)).toBe("0.00");
		expect((await chargeRow(c.id)).status).toBe("refunded");

		expect((await send("PAYMENT_CHARGEBACK_REQUESTED", c.paymentId, { value: 100 })).result).toBe("duplicate");
		expect((await send("PAYMENT_REFUNDED", c.paymentId, { value: 100 })).result).toBe("duplicate");
		expect(await clientBalance(c.clientId)).toBe("0.00");
	});

	it("caps the reversal at the wallet balance and records the shortfall", async () => {
		const c = await bound("Cb B");
		await send("PAYMENT_RECEIVED", c.paymentId, { value: 100 });
		await owner.query("update client_wallets set available = 30 where client_profile_id = $1", [c.clientId]);

		expect((await send("PAYMENT_CHARGEBACK_REQUESTED", c.paymentId)).result).toBe("refunded");
		expect(await clientBalance(c.clientId)).toBe("0.00");
		expect((await chargeRow(c.id)).refund_shortfall).toBe("70.00");
	});

	it("reverses a card installment charge once from any installment payment", async () => {
		const c = await bound("Cb C", { billing: "CREDIT_CARD", installments: 3 });
		await send("PAYMENT_CONFIRMED", c.paymentId, { value: 35.5, installment: c.installment });

		const other = await send("PAYMENT_CHARGEBACK_REQUESTED", `pay_${randomUUID()}`, { value: 35.5, installment: c.installment });

		expect(other.result).toBe("refunded");
		expect(await clientBalance(c.clientId)).toBe("0.00");
	});

	it.each(["PAYMENT_CHARGEBACK_DISPUTE", "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"])(
		"%s changes nothing and is stored as chargeback_ignored",
		async (event) => {
			const c = await bound("Cb D");
			await send("PAYMENT_RECEIVED", c.paymentId, { value: 100 });

			expect((await send(event, c.paymentId, { value: 100 })).result).toBe("chargeback_ignored");
			expect(await clientBalance(c.clientId)).toBe("100.00");
			expect((await chargeRow(c.id)).status).toBe("paid");
		},
	);
});

describe("amount check (043)", () => {
	it("Pix: credits the exact amount and an overpayment (late fee) at the row amount", async () => {
		const exact = await bound("Am A");
		const over = await bound("Am B");

		expect((await send("PAYMENT_RECEIVED", exact.paymentId, { value: 100 })).result).toBe("credited");
		expect((await send("PAYMENT_RECEIVED", over.paymentId, { value: 112.34 })).result).toBe("credited");
		expect(await clientBalance(exact.clientId)).toBe("100.00");
		expect(await clientBalance(over.clientId)).toBe("100.00");
	});

	it("Pix: an underpayment is stored as amount_mismatch, credits nothing, and a correct event still credits", async () => {
		const c = await bound("Am C");

		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 99.99 })).result).toBe("amount_mismatch");
		expect(await clientBalance(c.clientId)).toBe("0.00");
		expect((await chargeRow(c.id)).status).toBe("pending");

		expect((await send("PAYMENT_CONFIRMED", c.paymentId, { value: 100 })).result).toBe("credited");
		expect(await clientBalance(c.clientId)).toBe("100.00");
	});

	it("card 3x of 106,50: 35,50 and the remainder (35,51 / 35,47) credit; 35,40 does not", async () => {
		const exact = await bound("Am D", { billing: "CREDIT_CARD", installments: 3 });
		const remainder = await bound("Am E", { billing: "CREDIT_CARD", installments: 3 });
		const low = await bound("Am F", { billing: "CREDIT_CARD", installments: 3 });
		const tooLow = await bound("Am G", { billing: "CREDIT_CARD", installments: 3 });

		expect((await send("PAYMENT_CONFIRMED", exact.paymentId, { value: 35.5, installment: exact.installment })).result).toBe("credited");
		expect((await send("PAYMENT_CONFIRMED", remainder.paymentId, { value: 35.51, installment: remainder.installment })).result).toBe("credited");
		expect((await send("PAYMENT_CONFIRMED", low.paymentId, { value: 35.47, installment: low.installment })).result).toBe("credited");
		expect((await send("PAYMENT_CONFIRMED", tooLow.paymentId, { value: 35.4, installment: tooLow.installment })).result).toBe("amount_mismatch");
		expect(await clientBalance(exact.clientId)).toBe("100.00");
		expect(await clientBalance(tooLow.clientId)).toBe("0.00");
	});

	it("card in one payment compares with the total charged, not the credited amount", async () => {
		const ok = await bound("Am H", { billing: "CREDIT_CARD" });
		const lower = await bound("Am I", { billing: "CREDIT_CARD" });

		expect((await send("PAYMENT_CONFIRMED", ok.paymentId, { value: 106.5 })).result).toBe("credited");
		expect((await send("PAYMENT_CONFIRMED", lower.paymentId, { value: 100 })).result).toBe("amount_mismatch");
	});

	it("card without total_charged falls back to the amount", async () => {
		const c = await bound("Am J", { billing: "CREDIT_CARD", total: null, fee: "0.00" });

		expect((await send("PAYMENT_CONFIRMED", c.paymentId, { value: 99 })).result).toBe("amount_mismatch");
		expect((await send("PAYMENT_CONFIRMED", c.paymentId, { value: 100 })).result).toBe("credited");
	});

	it.each([
		["missing", {}],
		["not numeric", { value: "abc" }],
		["null", { value: null }],
	])("credits as before when payment.value is %s", async (_name, extra) => {
		const c = await bound("Am K");

		expect((await send("PAYMENT_RECEIVED", c.paymentId, extra)).result).toBe("credited");
		expect(await clientBalance(c.clientId)).toBe("100.00");
	});
});

describe("webhook payload hygiene (route)", () => {
	it("never stores the card token; keeps brand and last4", async () => {
		const c = await bound("Hy A", { billing: "CREDIT_CARD" });

		const { eventId } = await send("PAYMENT_CONFIRMED", c.paymentId, {
			value: 106.5,
			creditCard: { creditCardNumber: "4242", creditCardBrand: "VISA", creditCardToken: "tok_secret_123" },
		});

		const { rows } = await owner.query<{ payload: unknown }>("select payload from asaas_webhook_events where event_id = $1", [eventId]);
		const text = JSON.stringify(rows[0].payload);
		expect(text).not.toContain("tok_secret_123");
		expect(text).not.toContain("creditCardToken");
		expect(text).toContain("VISA");
		expect(text).toContain("4242");
		expect(await clientBalance(c.clientId)).toBe("100.00");
	});
});

describe("bind after the webhook won the race (043)", () => {
	it("a paid card charge still accepts the bind: only the null fields change", async () => {
		const tenant = await seedTenant(owner, "Race A");
		const id = await reserve(tenant.client, { kind: "client", clientProfileId: tenant.client.userId }, { billing: "CREDIT_CARD", installments: 3 });
		const paymentId = `pay_${randomUUID()}`;
		const installment = `ins_${randomUUID()}`;

		const credited = await send("PAYMENT_CONFIRMED", paymentId, { value: 35.5, installment, externalReference: await externalReference(id) });
		expect(credited.result).toBe("credited");

		const ok = await withUserTransaction(tenant.client, (c) =>
			bindAsaasCharge(c, id, { asaasPaymentId: paymentId, asaasInstallmentId: installment, cardBrand: "VISA", cardLast4: "4242" }),
		);

		expect(ok).toBe(true);
		expect(await chargeRow(id)).toMatchObject({
			status: "paid",
			asaas_payment_id: paymentId,
			asaas_installment_id: installment,
			card_brand: "VISA",
			card_last4: "4242",
		});

		const keep = await withUserTransaction(tenant.client, (c) =>
			bindAsaasCharge(c, id, { asaasPaymentId: paymentId, asaasInstallmentId: installment, cardBrand: "MASTER", cardLast4: "1111" }),
		);
		expect(keep).toBe(true);
		expect(await chargeRow(id)).toMatchObject({ card_brand: "VISA", card_last4: "4242" });
		expect(await clientBalance(tenant.client.userId)).toBe("100.00");
	});

	it("a paid Pix charge still refuses the bind, and a card bind of another payment is refused", async () => {
		const pix = await bound("Race B");
		await send("PAYMENT_RECEIVED", pix.paymentId, { value: 100 });
		const card = await bound("Race C", { billing: "CREDIT_CARD", installments: 2 });
		await send("PAYMENT_CONFIRMED", card.paymentId, { value: 53.25, installment: card.installment });

		const pixBind = await withUserTransaction(pix.tenant.client, (c) =>
			bindAsaasCharge(c, pix.id, { asaasPaymentId: pix.paymentId, pixPayload: "000201y" }),
		);
		const cardOther = await withUserTransaction(card.tenant.client, (c) =>
			bindAsaasCharge(c, card.id, { asaasPaymentId: `pay_${randomUUID()}`, cardBrand: "VISA" }),
		);

		expect(pixBind).toBe(false);
		expect(cardOther).toBe(false);
	});
});

describe("nfse_charge_by_payment by installment (043)", () => {
	it("finds a paid card charge by another installment payment id, and nothing without the installment", async () => {
		const c = await bound("Nf A", { billing: "CREDIT_CARD", installments: 3 });
		await send("PAYMENT_CONFIRMED", c.paymentId, { value: 35.5, installment: c.installment });
		const otherPayment = `pay_${randomUUID()}`;

		expect(await findNfseChargeByPayment(otherPayment)).toBeNull();
		expect(await findNfseChargeByPayment(otherPayment, `ins_${randomUUID()}`)).toBeNull();
		expect(await findNfseChargeByPayment(otherPayment, c.installment)).toEqual({
			chargeId: c.id,
			amount: "106.50",
			invoiceId: null,
			installmentId: c.installment,
		});
		expect((await findNfseChargeByPayment(c.paymentId))?.chargeId).toBe(c.id);
	});
});

describe("card attempt counters (043)", () => {
	const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

	it("exports the limits", () => {
		expect(MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR).toBe(10);
		expect(MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR).toBe(40);
	});

	it("by IP: counts card rows of every user and Bureau with that IP; not Pix, not other IPs, not old rows", async () => {
		// IP único por execução (24 bits): as linhas de pix_charges de execuções anteriores não são apagadas e entram na janela de 3 h.
		const ip = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const a = await seedTenant(owner, "Cnt A");
		const b = await seedTenant(owner, "Cnt B");
		const scopeA: ChargeScope = { kind: "client", clientProfileId: a.client.userId };
		const scopeB: ChargeScope = { kind: "client", clientProfileId: b.client.userId };
		await reserve(a.client, scopeA, { billing: "CREDIT_CARD", ip });
		await reserve(b.client, scopeB, { billing: "CREDIT_CARD", ip });
		await reserve(b.client, scopeB, { billing: "PIX", ip });
		await reserve(a.client, scopeA, { billing: "CREDIT_CARD", ip: "198.51.100.9" });
		const old = await reserve(a.client, scopeA, { billing: "CREDIT_CARD", ip });
		await owner.query("update pix_charges set created_at = now() - interval '2 hours' where id = $1", [old]);

		expect(await withUserTransaction(a.client, (c) => countRecentCardAttemptsByIp(c, ip, hourAgo()))).toBe(2);
		expect(await withUserTransaction(b.client, (c) => countRecentCardAttemptsByIp(c, ip, hourAgo()))).toBe(2);
		expect(await withUserTransaction(a.client, (c) => countRecentCardAttemptsByIp(c, "192.0.2.77", hourAgo()))).toBe(0);
		expect(await withUserTransaction(a.client, (c) => countRecentCardAttemptsByIp(c, ip, new Date(Date.now() - 3 * 3600 * 1000)))).toBe(3);
	});

	it("by Bureau: counts the card rows of every user of the own Bureau, none of another Bureau", async () => {
		const a = await seedTenant(owner, "Cnt C");
		const other = await seedTenant(owner, "Cnt D");
		const second = await seedClientProfile(owner, a.bureau.id);
		await reserve(a.client, { kind: "client", clientProfileId: a.client.userId }, { billing: "CREDIT_CARD" });
		await reserve(second, { kind: "client", clientProfileId: second.userId }, { billing: "CREDIT_CARD" });
		await reserve(a.bureauAdmin, { kind: "bureau", bureauId: a.bureau.id }, { billing: "CREDIT_CARD" });
		await reserve(a.client, { kind: "client", clientProfileId: a.client.userId }, { billing: "PIX" });
		await reserve(other.client, { kind: "client", clientProfileId: other.client.userId }, { billing: "CREDIT_CARD" });

		expect(await withUserTransaction(a.client, (c) => countRecentCardAttemptsByBureau(c, a.bureau.id, hourAgo()))).toBe(3);
		expect(await withUserTransaction(second, (c) => countRecentCardAttemptsByBureau(c, a.bureau.id, hourAgo()))).toBe(3);
		expect(await withUserTransaction(other.client, (c) => countRecentCardAttemptsByBureau(c, other.bureau.id, hourAgo()))).toBe(1);
	});

	it("by Bureau: refuses another Bureau; both counters refuse a call without a session", async () => {
		const a = await seedTenant(owner, "Cnt E");
		const other = await seedTenant(owner, "Cnt F");

		await expect(
			withUserTransaction(a.client, (c) => countRecentCardAttemptsByBureau(c, other.bureau.id, hourAgo())),
		).rejects.toThrow(/no session for this bureau/);
		await expect(pool.query("select public.count_recent_card_attempts_by_ip('1.1.1.1', now())")).rejects.toThrow(/no session/);
		await expect(pool.query("select public.count_recent_card_attempts_by_bureau($1, now())", [a.bureau.id])).rejects.toThrow(/no session/);
	});

	it("app_runtime cannot read another user's card row directly (the reason for the definer functions)", async () => {
		const a = await seedTenant(owner, "Cnt G");
		const second = await seedClientProfile(owner, a.bureau.id);
		await reserve(second, { kind: "client", clientProfileId: second.userId }, { billing: "CREDIT_CARD", ip: "203.0.113.250" });

		const direct = await withUserTransaction(a.client, (c) =>
			c.query("select count(*)::int as n from pix_charges where request_ip = '203.0.113.250'"),
		);

		expect(direct.rows[0].n).toBe(0);
		expect(await withUserTransaction(a.client, (c) => countRecentCardAttemptsByIp(c, "203.0.113.250", hourAgo()))).toBeGreaterThanOrEqual(1);
	});
});

describe("pending Pix caps ignore card rows (043)", () => {
	it("countPendingClientPixCharges and countPendingPixCharges count Pix only", async () => {
		const t = await seedTenant(owner, "Cap A");
		const clientScope: ChargeScope = { kind: "client", clientProfileId: t.client.userId };
		const bureauScope: ChargeScope = { kind: "bureau", bureauId: t.bureau.id };
		await reserve(t.client, clientScope, { billing: "PIX" });
		await reserve(t.client, clientScope, { billing: "CREDIT_CARD" });
		await reserve(t.client, clientScope, { billing: "CREDIT_CARD" });
		await reserve(t.bureauAdmin, bureauScope, { billing: "PIX" });
		await reserve(t.bureauAdmin, bureauScope, { billing: "CREDIT_CARD" });

		expect(await withUserTransaction(t.client, (c) => countPendingClientPixCharges(c, t.client.userId))).toBe(1);
		expect(await withUserTransaction(t.bureauAdmin, (c) => countPendingPixCharges(c, t.bureau.id))).toBe(1);
	});
});
