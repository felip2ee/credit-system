// Cartão parcelado: o webhook acha a cobrança pelo parcelamento e credita uma vez (migration 041).
// Roda contra um Postgres real, sob RLS, pela rota pública do webhook.

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

import { POST } from "@/app/api/webhooks/asaas/route";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant } from "@/test/seed";

import { bindAsaasCharge, reserveCharge } from "./pix-charges";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "i".repeat(32);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

type PaymentEvent = {
	event: string;
	paymentId: string;
	installment?: string;
	externalReference?: string;
	value?: number;
};

// Corpo do evento como o Asaas manda: cada parcela tem o próprio payment.id e o mesmo payment.installment.
async function send({ event, paymentId, installment, externalReference, value = 40 }: PaymentEvent): Promise<string> {
	const eventId = `evt_${randomUUID()}`;
	const body = {
		id: eventId,
		event,
		payment: {
			object: "payment",
			id: paymentId,
			value,
			...(installment ? { installment } : {}),
			...(externalReference ? { externalReference } : {}),
		},
	};
	const response = await POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: TOKEN }),
			body: JSON.stringify(body),
		}),
	);
	expect(response.status).toBe(200);
	const { rows } = await owner.query<{ result: string }>("select result from asaas_webhook_events where event_id = $1", [
		eventId,
	]);
	return rows[0].result;
}

async function clientBalance(clientProfileId: string): Promise<string> {
	const { rows } = await owner.query<{ available: string }>(
		"select available from client_wallets where client_profile_id = $1",
		[clientProfileId],
	);
	return rows[0].available;
}

const chargeRow = async (id: string) =>
	(await owner.query("select status, asaas_payment_id, asaas_installment_id from pix_charges where id = $1", [id])).rows[0];

// Cartão 3x do cliente: recarga de 100,00, taxa de 6,50, total de 106,50.
async function cardCharge(label: string, options: { bind: boolean } = { bind: true }) {
	const tenant = await seedTenant(owner, label);
	const client = tenant.client;
	const externalReference = randomUUID();
	const installment = `ins_${randomUUID()}`;
	const payments = [1, 2, 3].map(() => `pay_${randomUUID()}`);
	const reserved = await withUserTransaction(client, async (c) => {
		const row = await reserveCharge(c, client, {
			scope: { kind: "client", clientProfileId: client.userId },
			externalReference,
			amount: "100.00",
			billingType: "CREDIT_CARD",
			installments: 3,
			feeAmount: "6.50",
			totalCharged: "106.50",
			payerKind: "owner",
			payerDocumentMasked: "***.456.***-**",
		});
		if (row.ok && options.bind) {
			await bindAsaasCharge(c, row.id, {
				asaasPaymentId: payments[0],
				asaasInstallmentId: installment,
				cardBrand: "VISA",
				cardLast4: "4242",
			});
		}
		return row;
	});
	if (!reserved.ok) throw new Error("charge not reserved");
	return { tenant, client, id: reserved.id, externalReference, installment, payments };
}

describe("card installments through the webhook (migration 041)", () => {
	it("credits once for 3 PAYMENT_CONFIRMED of the same installment; a later PAYMENT_RECEIVED is duplicate", async () => {
		const { client, id, installment, payments } = await cardCharge("Inst A");

		const results = [];
		for (const paymentId of payments) {
			results.push(await send({ event: "PAYMENT_CONFIRMED", paymentId, installment }));
		}
		results.push(await send({ event: "PAYMENT_RECEIVED", paymentId: payments[0], installment }));

		expect(results).toEqual(["credited", "duplicate", "duplicate", "duplicate"]);
		expect(await clientBalance(client.userId)).toBe("100.00");
		expect((await chargeRow(id)).status).toBe("paid");
		const ledger = await owner.query("select amount from client_ledger_entries where client_profile_id = $1 and kind = 'topup'", [
			client.userId,
		]);
		expect(ledger.rows).toHaveLength(1);
	});

	it("reverses the whole credit once when installment 2 is refunded; a second refund is duplicate", async () => {
		const { client, installment, payments } = await cardCharge("Inst B");
		await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[0], installment });

		const first = await send({ event: "PAYMENT_REFUNDED", paymentId: payments[1], installment });
		const second = await send({ event: "PAYMENT_REFUNDED", paymentId: payments[2], installment });
		const late = await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[2], installment });

		expect([first, second, late]).toEqual(["refunded", "duplicate", "duplicate"]);
		expect(await clientBalance(client.userId)).toBe("0.00");
	});

	it("reports refund_shortfall when the credit was already spent, like Pix", async () => {
		const { client, id, installment, payments } = await cardCharge("Inst C");
		await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[0], installment });
		await owner.query("update client_wallets set available = 30 where client_profile_id = $1", [client.userId]);

		expect(await send({ event: "PAYMENT_REFUNDED", paymentId: payments[1], installment })).toBe("refunded");

		const { rows } = await owner.query("select status, refund_shortfall from pix_charges where id = $1", [id]);
		expect(rows[0]).toMatchObject({ status: "refunded", refund_shortfall: "70.00" });
	});

	it("returns unknown_charge for an installment event with no row", async () => {
		const result = await send({
			event: "PAYMENT_CONFIRMED",
			paymentId: `pay_${randomUUID()}`,
			installment: `ins_${randomUUID()}`,
		});

		expect(result).toBe("unknown_charge");
	});

	it("matches by externalReference when the event comes before the bind, then fills payment and installment ids", async () => {
		const { client, id, externalReference, installment, payments } = await cardCharge("Inst D", { bind: false });

		const first = await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[1], installment, externalReference });
		expect(first).toBe("credited");
		expect(await chargeRow(id)).toMatchObject({
			status: "paid",
			asaas_payment_id: payments[1],
			asaas_installment_id: installment,
		});

		// Parcela seguinte já acha pelo parcelamento; o bind tardio da parcela 1 não derruba nada.
		expect(await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[2], installment })).toBe("duplicate");
		expect(await clientBalance(client.userId)).toBe("100.00");
	});

	it("matches a card charge bound without installment by externalReference on another installment payment", async () => {
		const { client, id, externalReference, installment, payments } = await cardCharge("Inst E", { bind: false });
		await withUserTransaction(client, (c) => bindAsaasCharge(c, id, { asaasPaymentId: payments[0] }));

		const result = await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[1], installment, externalReference });

		expect(result).toBe("credited");
		expect(await chargeRow(id)).toMatchObject({ asaas_payment_id: payments[0], asaas_installment_id: installment });
		expect(await clientBalance(client.userId)).toBe("100.00");
	});

	it("does not let an installment id of one charge credit another charge", async () => {
		const a = await cardCharge("Inst F1");
		const b = await cardCharge("Inst F2");

		await send({ event: "PAYMENT_CONFIRMED", paymentId: a.payments[1], installment: a.installment });

		expect(await clientBalance(a.client.userId)).toBe("100.00");
		expect(await clientBalance(b.client.userId)).toBe("0.00");
		expect((await chargeRow(b.id)).status).toBe("pending");
	});

	it("ignores a payment on a cancelled card charge", async () => {
		const { client, id, installment, payments } = await cardCharge("Inst G");
		await owner.query("update pix_charges set status = 'cancelled' where id = $1", [id]);

		expect(await send({ event: "PAYMENT_CONFIRMED", paymentId: payments[0], installment })).toBe("ignored");
		expect(await clientBalance(client.userId)).toBe("0.00");
	});

	it("leaves Pix untouched: a Pix charge still credits by payment id", async () => {
		const tenant = await seedTenant(owner, "Inst H");
		const pixPaymentId = `pay_${randomUUID()}`;
		const pix = await withUserTransaction(tenant.client, async (c) => {
			const row = await reserveCharge(c, tenant.client, {
				scope: { kind: "client", clientProfileId: tenant.client.userId },
				externalReference: randomUUID(),
				amount: "100.00",
				billingType: "PIX",
				installments: 1,
				feeAmount: "0.00",
				totalCharged: null,
				payerKind: "owner",
				payerDocumentMasked: "***.456.***-**",
			});
			if (row.ok) await bindAsaasCharge(c, row.id, { asaasPaymentId: pixPaymentId, pixPayload: "000201h" });
			return row;
		});
		if (!pix.ok) throw new Error("not reserved");

		expect(await send({ event: "PAYMENT_RECEIVED", paymentId: pixPaymentId, value: 100 })).toBe("credited");
		expect(await clientBalance(tenant.client.userId)).toBe("100.00");
	});
});
