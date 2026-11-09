// Taxa do Pix repassada ao pagador (migration 045): o Pix cobra recarga + taxa, o saldo sobe e desce só pela recarga,
// o webhook confere o valor contra o total e a NFS-e sai pelo total. Postgres real, sob RLS, pela rota pública do webhook.

import { randomUUID } from "node:crypto";

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
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { findNfseChargeByPayment } from "@/lib/nfse/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant } from "@/test/seed";

import { bindAsaasCharge, reserveCharge } from "./pix-charges";

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
			"select status, amount, fee_amount, total_charged, refund_shortfall from pix_charges where id = $1",
			[id],
		)
	).rows[0];


// Pix de R$ 100,00 de recarga. fee em reais ("1.99"); sem fee a linha fica como antes da 045 (total nulo).
async function boundPix(label: string, fee: string | null) {
	const tenant = await seedTenant(owner, label);
	const clientId = tenant.client.userId;
	const reserved = await withUserTransaction(tenant.client, (c) =>
		reserveCharge(c, tenant.client, {
			scope: { kind: "client", clientProfileId: clientId },
			externalReference: randomUUID(),
			amount: "100.00",
			billingType: "PIX",
			installments: 1,
			feeAmount: fee ?? "0.00",
			totalCharged: fee === null ? null : (100 + Number(fee)).toFixed(2),
			payerKind: "owner",
			payerDocumentMasked: "***.456.***-**",
		}),
	);
	if (!reserved.ok) throw new Error("not reserved");
	const paymentId = `pay_${randomUUID()}`;
	await withUserTransaction(tenant.client, (c) =>
		bindAsaasCharge(c, reserved.id, { asaasPaymentId: paymentId, pixPayload: "000201x" }),
	);
	return { tenant, clientId, id: reserved.id, paymentId };
}

describe("Pix com taxa repassada (045)", () => {
	it("stores fee and total, and credits only the recharge when the payer pays recharge + fee", async () => {
		const c = await boundPix("Fee A", "1.99");
		expect(await chargeRow(c.id)).toMatchObject({ amount: "100.00", fee_amount: "1.99", total_charged: "101.99" });
		const audit = await owner.query(
			"select metadata from audit_logs where action = 'wallet.topup.request' and record_id = $1",
			[c.id],
		);
		expect(audit.rows[0].metadata).toMatchObject({ amount: "100.00", feeAmount: "1.99", totalCharged: "101.99" });

		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 101.99 })).result).toBe("credited");

		expect(await clientBalance(c.clientId)).toBe("100.00");
	});

	it("refuses a payment of only the recharge (fee missing): no credit, charge stays pending", async () => {
		const c = await boundPix("Fee B", "1.99");

		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 100 })).result).toBe("amount_mismatch");

		expect(await clientBalance(c.clientId)).toBe("0.00");
		expect((await chargeRow(c.id)).status).toBe("pending");
	});

	it("a payment above the total still credits the recharge only", async () => {
		const c = await boundPix("Fee C", "1.99");

		expect((await send("PAYMENT_CONFIRMED", c.paymentId, { value: 105 })).result).toBe("credited");

		expect(await clientBalance(c.clientId)).toBe("100.00");
	});

	it("refund reverses the recharge (100,00), never the total, and a duplicate does nothing", async () => {
		const c = await boundPix("Fee D", "1.99");
		await send("PAYMENT_RECEIVED", c.paymentId, { value: 101.99 });
		await owner.query("update client_wallets set available = 150 where client_profile_id = $1", [c.clientId]);

		expect((await send("PAYMENT_REFUNDED", c.paymentId, { value: 101.99 })).result).toBe("refunded");
		expect(await clientBalance(c.clientId)).toBe("50.00");
		expect((await chargeRow(c.id)).refund_shortfall).toBe("0.00");

		expect((await send("PAYMENT_REFUNDED", c.paymentId, { value: 101.99 })).result).toBe("duplicate");
		expect(await clientBalance(c.clientId)).toBe("50.00");
	});

	it("refund shortfall is measured on the recharge, not on the total", async () => {
		const c = await boundPix("Fee E", "1.99");
		await send("PAYMENT_RECEIVED", c.paymentId, { value: 101.99 });
		await owner.query("update client_wallets set available = 30 where client_profile_id = $1", [c.clientId]);

		await send("PAYMENT_REFUNDED", c.paymentId, { value: 101.99 });

		expect(await clientBalance(c.clientId)).toBe("0.00");
		expect((await chargeRow(c.id)).refund_shortfall).toBe("70.00");
	});

	it("the invoice amount is the total the payer paid", async () => {
		const withFee = await boundPix("Fee F", "1.99");
		const noFee = await boundPix("Fee G", null);
		await send("PAYMENT_RECEIVED", withFee.paymentId, { value: 101.99 });
		await send("PAYMENT_RECEIVED", noFee.paymentId, { value: 100 });

		expect((await findNfseChargeByPayment(withFee.paymentId))?.amount).toBe("101.99");
		expect((await findNfseChargeByPayment(noFee.paymentId))?.amount).toBe("100.00");
	});

	it("zero fee keeps the old behavior: total null, paid value checked against the amount", async () => {
		const c = await boundPix("Fee H", null);
		expect(await chargeRow(c.id)).toMatchObject({ fee_amount: "0.00", total_charged: null });

		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 99.99 })).result).toBe("amount_mismatch");
		expect((await send("PAYMENT_RECEIVED", c.paymentId, { value: 100 })).result).toBe("credited");
		expect(await clientBalance(c.clientId)).toBe("100.00");
	});

	it("the shape check rejects a Pix whose total is not amount + fee, or a fee without a total", async () => {
		const tenant = await seedTenant(owner, "Fee I");
		const reserve = (feeAmount: string, totalCharged: string | null) =>
			withUserTransaction(tenant.client, (c) =>
				reserveCharge(c, tenant.client, {
					scope: { kind: "client", clientProfileId: tenant.client.userId },
					externalReference: randomUUID(),
					amount: "100.00",
					billingType: "PIX",
					installments: 1,
					feeAmount,
					totalCharged,
					payerKind: "owner",
					payerDocumentMasked: "***.456.***-**",
				}),
			);

		await expect(reserve("1.99", "100.00")).rejects.toThrow(/pix_charges_billing_shape_check/);
		await expect(reserve("1.99", null)).rejects.toThrow(/pix_charges_billing_shape_check/);
		await expect(reserve("0.00", "100.00")).resolves.toMatchObject({ ok: true });
	});
});
