import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
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
	return { token: "t".repeat(32) };
});

import {
	ASAAS_API_KEY_HEADER,
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_ERROR,
	ASAAS_EVENT_PAYMENT_CONFIRMED,
	ASAAS_EVENT_PAYMENT_RECEIVED,
	ASAAS_EVENT_PAYMENT_REFUNDED,
	createAsaasClient,
} from "./client";
import { buildFakeInvoiceEvent, buildFakePaymentEvent, createFakeAsaasClient } from "./fake";
import { getAsaasClient } from "./index";

const input = { amount: "25.50", externalReference: "ref-1", description: "Recarga de carteira" };
const settings = { apiKey: "secret-key", baseUrl: "https://api.asaas.example/", customerId: "cus_1" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createAsaasClient", () => {
	it("creates the PIX payment, then reads its QR code", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ id: "pay_123" }))
			.mockResolvedValueOnce(jsonResponse({ encodedImage: "QUJD", payload: "000201pix" }));

		const result = await createAsaasClient(settings, fetchMock).createPixCharge(input);

		expect(result).toEqual({ asaasPaymentId: "pay_123", pixPayload: "000201pix", qrImageBase64: "QUJD" });
		const [createUrl, createInit] = fetchMock.mock.calls[0];
		expect(createUrl).toBe("https://api.asaas.example/v3/payments");
		expect(createInit.method).toBe("POST");
		expect(createInit.headers[ASAAS_API_KEY_HEADER]).toBe("secret-key");
		expect(JSON.parse(createInit.body)).toMatchObject({
			customer: "cus_1",
			billingType: "PIX",
			value: 25.5,
			externalReference: "ref-1",
			description: "Recarga de carteira",
		});
		expect(JSON.parse(createInit.body).dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(fetchMock.mock.calls[1][0]).toBe("https://api.asaas.example/v3/payments/pay_123/pixQrCode");
	});

	it("throws without leaking the key or the response body when Asaas fails", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ description: "chave secret-key" }] }, 401));

		const error = await createAsaasClient(settings, fetchMock)
			.createPixCharge(input)
			.catch((e: Error) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Asaas respondeu 401 em POST /v3/payments");
		expect((error as Error).message).not.toContain("secret-key");
	});

	it("throws when the QR step fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ id: "pay_123" }))
			.mockResolvedValueOnce(jsonResponse({}, 500));

		await expect(createAsaasClient(settings, fetchMock).createPixCharge(input)).rejects.toThrow(
			"Asaas respondeu 500 em GET /v3/payments/{id}/pixQrCode",
		);
	});

	it("throws when the reply has an unexpected shape", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));

		await expect(createAsaasClient(settings, fetchMock).createPixCharge(input)).rejects.toThrow(
			"Resposta inválida do Asaas em POST /v3/payments",
		);
	});
});

const invoiceInput = {
	paymentId: "pay_123",
	amount: "25.50",
	externalReference: "chg-1",
	service: {
		municipalServiceId: "svc_1",
		municipalServiceName: "Licenciamento de programas",
		serviceDescription: "Recarga de créditos",
		issRate: 2.5,
		retainIss: false,
	},
};

describe("scheduleInvoice", () => {
	it("posts the invoice for the payment and returns the invoice id", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "inv_1", status: "SCHEDULED", number: null }));

		const result = await createAsaasClient(settings, fetchMock).scheduleInvoice(invoiceInput);

		expect(result).toEqual({ asaasInvoiceId: "inv_1" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/invoices");
		expect(init.method).toBe("POST");
		expect(init.headers[ASAAS_API_KEY_HEADER]).toBe("secret-key");
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			payment: "pay_123",
			municipalServiceId: "svc_1",
			municipalServiceName: "Licenciamento de programas",
			serviceDescription: "Recarga de créditos",
			value: 25.5,
			externalReference: "chg-1",
			taxes: { retainIss: false, iss: 2.5 },
		});
		expect(body.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(body).not.toHaveProperty("municipalServiceCode");
	});

	it("sends the municipal service code when there is no id", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "inv_1" }));
		const { municipalServiceId: _id, ...rest } = invoiceInput.service;

		await createAsaasClient(settings, fetchMock).scheduleInvoice({
			...invoiceInput,
			service: { ...rest, municipalServiceCode: "1.05" },
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.municipalServiceCode).toBe("1.05");
		expect(body).not.toHaveProperty("municipalServiceId");
	});

	it("throws without the key or the response body when Asaas refuses", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ description: "secret-key" }] }, 400));

		const error = await createAsaasClient(settings, fetchMock)
			.scheduleInvoice(invoiceInput)
			.catch((e: Error) => e);

		expect((error as Error).message).toBe("Asaas respondeu 400 em POST /v3/invoices");
	});

	it("throws on an unexpected reply shape", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));

		await expect(createAsaasClient(settings, fetchMock).scheduleInvoice(invoiceInput)).rejects.toThrow(
			"Resposta inválida do Asaas em POST /v3/invoices",
		);
	});
});

describe("fake client", () => {
	it("returns deterministic ids from the external reference", async () => {
		const fake = createFakeAsaasClient();
		const first = await fake.createPixCharge(input);
		const second = await fake.createPixCharge(input);

		expect(first).toEqual(second);
		expect(first.asaasPaymentId).toBe("pay_fake_ref-1");
		expect(first.pixPayload).toContain("ref-1");
	});

	it("schedules a deterministic invoice", async () => {
		const result = await createFakeAsaasClient().scheduleInvoice(invoiceInput);

		expect(result).toEqual({ asaasInvoiceId: "inv_fake_chg-1" });
	});

	it("builds an invoice webhook body", () => {
		expect(
			buildFakeInvoiceEvent({
				eventId: "evt_9",
				event: ASAAS_EVENT_INVOICE_AUTHORIZED,
				asaasPaymentId: "pay_1",
				number: "123",
				pdfUrl: "https://nfse.example/123.pdf",
			}),
		).toEqual({
			id: "evt_9",
			event: "INVOICE_AUTHORIZED",
			invoice: {
				object: "invoice",
				id: "inv_fake_pay_1",
				status: "AUTHORIZED",
				payment: "pay_1",
				number: "123",
				pdfUrl: "https://nfse.example/123.pdf",
			},
		});
		expect(buildFakeInvoiceEvent({ eventId: "e", event: ASAAS_EVENT_INVOICE_ERROR, asaasPaymentId: "pay_1" }).invoice.status).toBe(
			"ERROR",
		);
	});

	it("builds a payment webhook body for a charge", () => {
		expect(buildFakePaymentEvent({ eventId: "evt_1", asaasPaymentId: "pay_fake_ref-1", value: 25.5 })).toEqual({
			id: "evt_1",
			event: "PAYMENT_RECEIVED",
			payment: { object: "payment", id: "pay_fake_ref-1", value: 25.5 },
		});
	});
});

describe("getAsaasClient", () => {
	it("fails with a clear error when no driver is configured", () => {
		vi.stubEnv("ASAAS_DRIVER", "");
		vi.stubEnv("ASAAS_WEBHOOK_TOKEN", env.token);
		expect(() => getAsaasClient()).toThrow("ASAAS_DRIVER is required");
		vi.unstubAllEnvs();
	});

	it("returns the fake client for the fake driver", async () => {
		vi.stubEnv("ASAAS_DRIVER", "fake");
		vi.stubEnv("ASAAS_WEBHOOK_TOKEN", env.token);
		const result = await getAsaasClient().createPixCharge(input);
		expect(result.asaasPaymentId).toBe("pay_fake_ref-1");
		vi.unstubAllEnvs();
	});
});

// apply_asaas_payment decide por nome de evento em SQL: o nome do SQL e o da constante não podem divergir.
describe("event names in apply_asaas_payment", () => {
	const sql = readFileSync(resolve(process.cwd(), "db/migrations/014_wallet_refund_and_webhook_role.sql"), "utf8");

	it.each([ASAAS_EVENT_PAYMENT_RECEIVED, ASAAS_EVENT_PAYMENT_CONFIRMED, ASAAS_EVENT_PAYMENT_REFUNDED])(
		"spells %s the same in SQL",
		(name) => {
			expect(sql).toContain(`'${name}'`);
		},
	);
});
