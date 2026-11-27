import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "w".repeat(32);

const state = vi.hoisted(() => ({
	applyAsaasPayment: vi.fn(),
	readWebhookDatabaseUrl: vi.fn(),
	requestInvoiceForPayment: vi.fn(),
	repairInvoiceForPayment: vi.fn(),
	applyInvoiceEvent: vi.fn(),
	applyChargeSplitEvent: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: state.revalidatePath }));

vi.mock("@/lib/config", () => ({
	readAsaasConfig: () => ({ driver: "fake", webhookToken: "w".repeat(32) }),
	readWebhookDatabaseUrl: state.readWebhookDatabaseUrl,
}));
vi.mock("@/lib/wallet/pix-charges", () => ({ applyAsaasPayment: state.applyAsaasPayment }));
vi.mock("@/lib/asaas/split-events", async () => {
	const actual = await vi.importActual<typeof import("@/lib/asaas/split-events")>("@/lib/asaas/split-events");
	return { ...actual, applyChargeSplitEvent: state.applyChargeSplitEvent };
});
// invoice.ts real só para o parseInvoiceEvent; as dependências com banco e Asaas saem de cena.
vi.mock("@/lib/nfse/queries", () => ({}));
vi.mock("@/lib/asaas", () => ({}));
vi.mock("@/lib/nfse/invoice", async () => {
	const { parseInvoiceEvent } = await vi.importActual<typeof import("@/lib/nfse/invoice")>("@/lib/nfse/invoice");
	return {
		parseInvoiceEvent,
		requestInvoiceForPayment: state.requestInvoiceForPayment,
		repairInvoiceForPayment: state.repairInvoiceForPayment,
		applyInvoiceEvent: state.applyInvoiceEvent,
	};
});

import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";

import { POST } from "./route";

const body = {
	id: "evt_1",
	event: "PAYMENT_RECEIVED",
	payment: { object: "payment", id: "pay_1", value: 9999 },
};

function call(payload: unknown, token: string | null = TOKEN) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token !== null) headers.set(ASAAS_WEBHOOK_TOKEN_HEADER, token);
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers,
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.applyAsaasPayment.mockResolvedValue("credited");
	state.readWebhookDatabaseUrl.mockReturnValue("postgres://app_webhook:x@localhost/db");
	state.requestInvoiceForPayment.mockResolvedValue("pending");
	state.repairInvoiceForPayment.mockResolvedValue("not_requested");
	state.applyInvoiceEvent.mockResolvedValue("issued");
	state.applyChargeSplitEvent.mockResolvedValue("updated");
});

describe("POST /api/webhooks/asaas auth", () => {
	it.each([null, "", "wrong", "w".repeat(31), "w".repeat(33)])("rejects token %j with 401 and writes nothing", async (token) => {
		const response = await call(body, token);

		expect(response.status).toBe(401);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/asaas body", () => {
	it("returns 400 for invalid JSON", async () => {
		const response = await call("{broken");

		expect(response.status).toBe(400);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});

	it.each([
		["no event type", { id: "evt_1", payment: { id: "pay_1" } }],
		["no payment id", { id: "evt_1", event: "PAYMENT_RECEIVED", payment: {} }],
		["no payment", { id: "evt_1", event: "ACCOUNT_STATUS_UPDATED" }],
	])("answers 200, logs one line and writes nothing for valid JSON with %s", async (_name, payload) => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await call(payload);

		expect(response.status).toBe(200);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(log.mock.calls)).not.toContain("pay_1");
		log.mockRestore();
	});
});

describe("POST /api/webhooks/asaas event id", () => {
	it.each(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_REFUNDED"])(
		"derives the event id from event and payment id for %s without a top-level id",
		async (event) => {
			const payload = { event, payment: { id: "pay_1" } };

			const response = await call(payload);

			expect(response.status).toBe(200);
			expect(state.applyAsaasPayment).toHaveBeenCalledWith({
				eventId: `${event}:pay_1`,
				eventType: event,
				asaasPaymentId: "pay_1",
				payload,
			});
		},
	);

	it("keeps the top-level id when present", async () => {
		await call(body);

		expect(state.applyAsaasPayment.mock.calls[0][0].eventId).toBe("evt_1");
	});

	it("answers 500 and writes nothing when DATABASE_WEBHOOK_URL is missing", async () => {
		state.readWebhookDatabaseUrl.mockImplementation(() => {
			throw new Error("DATABASE_WEBHOOK_URL is required");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(body);

		expect(response.status).toBe(500);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/asaas result", () => {
	it("forwards event id, type, payment id and the raw payload", async () => {
		const response = await call(body);

		expect(response.status).toBe(200);
		expect(state.applyAsaasPayment).toHaveBeenCalledWith({
			eventId: "evt_1",
			eventType: "PAYMENT_RECEIVED",
			asaasPaymentId: "pay_1",
			payload: body,
		});
	});

	it.each(["credited", "refunded", "duplicate", "ignored", "unknown_charge", "partial_refund_ignored", "chargeback_ignored", "amount_mismatch"])("answers 200 for %s", async (result) => {
		state.applyAsaasPayment.mockResolvedValue(result);

		expect((await call(body)).status).toBe(200);
	});

	it("answers 500 on a database error so Asaas retries", async () => {
		state.applyAsaasPayment.mockRejectedValue(new Error("connection lost"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(body);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("connection lost");
	});
});

describe("POST /api/webhooks/asaas payload hygiene and logs", () => {
	it("keeps only brand and last4 of the card; the token and other card keys never reach the database call", async () => {
		const payload = {
			...body,
			payment: {
				...body.payment,
				creditCard: { creditCardNumber: "4242", creditCardBrand: "VISA", creditCardToken: "tok_secret", holder: "X" },
			},
		};

		await call(payload);

		const sent = state.applyAsaasPayment.mock.calls[0][0].payload;
		expect(sent.payment.creditCard).toEqual({ creditCardNumber: "4242", creditCardBrand: "VISA" });
		expect(JSON.stringify(sent)).not.toContain("tok_secret");
		expect(sent.payment.id).toBe("pay_1");
		expect(sent.payment.value).toBe(9999);
	});

	it("drops a card number that is not exactly 4 digits and a non-object creditCard", async () => {
		await call({ ...body, payment: { ...body.payment, creditCard: { creditCardNumber: "4242424242424242", creditCardBrand: "VISA" } } });
		await call({ ...body, payment: { ...body.payment, creditCard: "tok_secret" } });

		expect(state.applyAsaasPayment.mock.calls[0][0].payload.payment.creditCard).toEqual({ creditCardBrand: "VISA" });
		expect(state.applyAsaasPayment.mock.calls[1][0].payload.payment.creditCard).toEqual({});
	});

	it("passes payment.installment to the invoice steps, and ignores a malformed installment", async () => {
		await call({ ...body, payment: { ...body.payment, installment: "ins_1" } });
		await call({ ...body, id: "evt_2", payment: { ...body.payment, installment: 7 } });

		expect(state.requestInvoiceForPayment).toHaveBeenNthCalledWith(1, "pay_1", "ins_1");
		expect(state.requestInvoiceForPayment).toHaveBeenNthCalledWith(2, "pay_1", undefined);
	});

	it("logs a chargeback without handling with the event and charge id only", async () => {
		state.applyAsaasPayment.mockResolvedValue("chargeback_ignored");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call({ ...body, event: "PAYMENT_CHARGEBACK_DISPUTE", payment: { ...body.payment, creditCard: { creditCardToken: "tok_secret" } } });

		expect(response.status).toBe(200);
		expect(log).toHaveBeenCalledWith("[asaas-webhook] chargeback sem tratamento", {
			event: "PAYMENT_CHARGEBACK_DISPUTE",
			asaasPaymentId: "pay_1",
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("tok_secret");
		log.mockRestore();
	});

	it("logs a diverging amount with the charge id only and does not schedule an invoice", async () => {
		state.applyAsaasPayment.mockResolvedValue("amount_mismatch");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(body);

		expect(response.status).toBe(200);
		expect(log).toHaveBeenCalledWith("[asaas-webhook] valor divergente", { asaasPaymentId: "pay_1" });
		expect(state.requestInvoiceForPayment).not.toHaveBeenCalled();
		log.mockRestore();
	});
});

const invoiceBody = {
	id: "evt_inv_1",
	event: "INVOICE_AUTHORIZED",
	invoice: { object: "invoice", id: "inv_1", status: "AUTHORIZED", payment: "pay_1", number: "123", pdfUrl: "https://nfse.example/1.pdf" },
};

describe("POST /api/webhooks/asaas invoice events", () => {
	it.each([null, "wrong"])("rejects an invoice event with token %j with 401 and writes nothing", async (token) => {
		const response = await call(invoiceBody, token);

		expect(response.status).toBe(401);
		expect(state.applyInvoiceEvent).not.toHaveBeenCalled();
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});

	it("applies the invoice event and never touches the wallet path", async () => {
		const response = await call(invoiceBody);

		expect(response.status).toBe(200);
		expect(state.applyInvoiceEvent).toHaveBeenCalledWith(
			expect.objectContaining({ event: "INVOICE_AUTHORIZED", invoice: expect.objectContaining({ payment: "pay_1" }) }),
		);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
		expect(state.requestInvoiceForPayment).not.toHaveBeenCalled();
	});

	it("answers 200, logs one line and writes nothing for an invoice event without payment", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await call({ id: "evt_inv_2", event: "INVOICE_AUTHORIZED", invoice: { id: "inv_1" } });

		expect(response.status).toBe(200);
		expect(state.applyInvoiceEvent).not.toHaveBeenCalled();
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});

	it("answers 500 on a database error so Asaas retries", async () => {
		state.applyInvoiceEvent.mockRejectedValue(new Error("connection lost"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(invoiceBody);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("connection lost");
	});
});

describe("POST /api/webhooks/asaas invoice scheduling after the credit", () => {
	it("schedules the invoice for a credited payment, after the credit", async () => {
		const response = await call(body);

		expect(response.status).toBe(200);
		expect(state.requestInvoiceForPayment).toHaveBeenCalledWith("pay_1", undefined);
		expect(state.applyAsaasPayment.mock.invocationCallOrder[0]).toBeLessThan(
			state.requestInvoiceForPayment.mock.invocationCallOrder[0],
		);
	});

	it.each(["refunded", "duplicate", "ignored", "unknown_charge"])("does not schedule an invoice for %s", async (result) => {
		state.applyAsaasPayment.mockResolvedValue(result);

		await call(body);

		expect(state.requestInvoiceForPayment).not.toHaveBeenCalled();
	});

	it("repairs the invoice on a duplicate credit event", async () => {
		state.applyAsaasPayment.mockResolvedValue("duplicate");

		expect((await call(body)).status).toBe(200);
		expect(state.repairInvoiceForPayment).toHaveBeenCalledWith("pay_1", undefined);
	});

	it.each([
		["duplicate", "PAYMENT_REFUNDED"],
		["credited", "PAYMENT_RECEIVED"],
		["ignored", "PAYMENT_RECEIVED"],
		["unknown_charge", "PAYMENT_RECEIVED"],
	])("does not repair the invoice for %s %s", async (result, event) => {
		state.applyAsaasPayment.mockResolvedValue(result);

		await call({ ...body, event });

		expect(state.repairInvoiceForPayment).not.toHaveBeenCalled();
	});

	it("keeps the 200 when the repair rejects, and logs it", async () => {
		state.applyAsaasPayment.mockResolvedValue("duplicate");
		state.repairInvoiceForPayment.mockRejectedValue(new Error("x"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await call(body)).status).toBe(200);
		await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[asaas-webhook] reparo da nota falhou", { name: "Error", code: undefined }));
	});

	it("keeps the 200 when the invoice step fails, and logs it", async () => {
		state.requestInvoiceForPayment.mockRejectedValue(new Error("asaas down"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await call(body)).status).toBe(200);
		await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[asaas-webhook] pedido da nota falhou", { name: "Error", code: undefined }));
	});

	it("answers 200 before a slow Asaas invoice call finishes", async () => {
		let finish: (value: string) => void = () => {};
		state.requestInvoiceForPayment.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));

		const response = await call(body);

		expect(response.status).toBe(200);
		expect(state.requestInvoiceForPayment).toHaveBeenCalledWith("pay_1", undefined);
		finish("pending");
	});

	it("revalidates the client credits page after a credit, and keeps the 200 if revalidation throws", async () => {
		await call(body);
		expect(state.revalidatePath).toHaveBeenCalledWith("/portal/credits");

		state.revalidatePath.mockImplementation(() => {
			throw new Error("no static generation store");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await call(body)).status).toBe(200);
	});

	it("does not revalidate when nothing was credited", async () => {
		state.applyAsaasPayment.mockResolvedValue("duplicate");

		await call(body);

		expect(state.revalidatePath).not.toHaveBeenCalled();
	});

	it("does not schedule when the credit itself fails", async () => {
		state.applyAsaasPayment.mockRejectedValue(new Error("connection lost"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await call(body)).status).toBe(500);
		expect(state.requestInvoiceForPayment).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/asaas split events", () => {
	const split = [{ id: "spl_1", walletId: "w-1", status: "DONE" }];

	it("PAYMENT_SPLIT_DONE updates the splits and never reaches apply_asaas_payment", async () => {
		const response = await call({ id: "evt_s", event: "PAYMENT_SPLIT_DONE", payment: { id: "pay_1", split } });

		expect(response.status).toBe(200);
		expect(state.applyChargeSplitEvent).toHaveBeenCalledWith({
			eventId: "evt_s",
			eventType: "PAYMENT_SPLIT_DONE",
			asaasPaymentId: "pay_1",
			splits: split,
		});
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});

	it("a chargeback updates the splits and still goes to apply_asaas_payment", async () => {
		const response = await call({ id: "evt_c", event: "PAYMENT_CHARGEBACK_REQUESTED", payment: { id: "pay_1", split } });

		expect(response.status).toBe(200);
		expect(state.applyChargeSplitEvent).toHaveBeenCalledOnce();
		expect(state.applyAsaasPayment).toHaveBeenCalledOnce();
	});

	it("a payment event does not touch the splits", async () => {
		await call({ ...body, payment: { ...body.payment, split } });

		expect(state.applyChargeSplitEvent).not.toHaveBeenCalled();
	});

	it("a malformed split array is ignored with 200", async () => {
		const response = await call({ id: "evt_b", event: "PAYMENT_SPLIT_DONE", payment: { id: "pay_1", split: "x" } });

		expect(response.status).toBe(200);
		expect(state.applyChargeSplitEvent).not.toHaveBeenCalled();
	});

	it("returns 500 when the split update fails, so Asaas resends", async () => {
		state.applyChargeSplitEvent.mockRejectedValueOnce(new Error("db down"));
		const response = await call({ id: "evt_f", event: "PAYMENT_SPLIT_DONE", payment: { id: "pay_1", split } });

		expect(response.status).toBe(500);
	});

	it("an unbound charge of this system answers 500 on a split-only event, so Asaas resends", async () => {
		state.applyChargeSplitEvent.mockResolvedValueOnce("unbound_charge");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const payment = { id: "pay_1", split, installment: "ins_1", externalReference: "ref_1" };

		expect((await call({ id: "evt_u", event: "PAYMENT_SPLIT_DONE", payment })).status).toBe(500);
		expect(state.applyChargeSplitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ asaasInstallmentId: "ins_1", externalReference: "ref_1" }),
		);
	});

	it("an unbound charge on a refund event still goes to apply_asaas_payment, which binds it", async () => {
		state.applyChargeSplitEvent.mockResolvedValueOnce("unbound_charge");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect((await call({ id: "evt_v", event: "PAYMENT_REFUNDED", payment: { id: "pay_1", split } })).status).toBe(200);
		expect(state.applyAsaasPayment).toHaveBeenCalledOnce();
	});
});
