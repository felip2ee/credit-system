import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
	AsaasHttpError,
	AsaasOutcomeUnknownError,
	CardDeclinedError,
	createAsaasClient,
} from "./client";
import {
	buildFakeInvoiceEvent,
	buildFakePaymentEvent,
	createFakeAsaasClient,
	deleteFakeCustomer,
	getFakeCustomer,
	resetFakeCustomers,
	resetFakeInvoices,
} from "./fake";
import type { CardChargeInput } from "./types";
import { getAsaasClient } from "./index";

const input = { customerId: "cus_1", amount: "25.50", externalReference: "ref-1", description: "Recarga de carteira" };
const settings = { apiKey: "secret-key", baseUrl: "https://api.asaas.example/" };

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

const DOCUMENT = "12345678909";
const CARD_NUMBER = "4111111111111111";
const CCV = "737";

const cardInput: CardChargeInput = {
	customerId: "cus_1",
	externalReference: "ref-card-1",
	description: "Recarga de carteira",
	totalCents: 10_500,
	installments: 1,
	installmentCents: 10_500,
	card: { holderName: "MARIA SILVA", number: CARD_NUMBER, expiryMonth: "12", expiryYear: "2030", ccv: CCV },
	holder: {
		name: "Maria Silva",
		email: "maria@example.test",
		cpfCnpj: DOCUMENT,
		postalCode: "01310100",
		addressNumber: "100",
		phone: "11999994321",
	},
	remoteIp: "203.0.113.9",
};
const cardReply = { id: "pay_card_1", installment: null, creditCard: { creditCardBrand: "VISA", creditCardNumber: "1111" } };

describe("customers", () => {
	const customerInput = { name: "Maria Silva", cpfCnpj: DOCUMENT, email: "maria@example.test" };

	it("finds the oldest non-deleted customer by external reference, never by document", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				data: [
					{ id: "cus_new", deleted: false, dateCreated: "2026-05-01" },
					{ id: "cus_gone", deleted: true, dateCreated: "2020-01-01" },
					{ id: "cus_old", deleted: false, dateCreated: "2024-02-10" },
				],
			}),
		);

		const id = await createAsaasClient(settings, fetchMock).findCustomerByExternalReference("pp 1/a");

		expect(id).toBe("cus_old");
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/customers?externalReference=pp%201%2Fa&limit=100");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	});

	it("returns null when nothing is found or all customers are deleted", async () => {
		const find = (data: unknown[]) =>
			createAsaasClient(settings, vi.fn().mockResolvedValue(jsonResponse({ data }))).findCustomerByExternalReference("ref");

		expect(await find([])).toBeNull();
		expect(await find([{ id: "cus_gone", deleted: true }])).toBeNull();
	});

	it("never puts the reference in an error, in a log or in the unknown-outcome message", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
		const fail = (response: Response) =>
			createAsaasClient(settings, vi.fn().mockResolvedValue(response))
				.findCustomerByExternalReference("ref-secret")
				.catch((e: Error) => e);

		const errors = [await fail(jsonResponse({}, 500)), await fail(jsonResponse({}, 403)), await fail(jsonResponse({ bad: 1 }))];
		const timeout = await createAsaasClient(settings, vi.fn().mockRejectedValue(new Error("GET ?externalReference=ref-secret")))
			.findCustomerByExternalReference("ref-secret")
			.catch((e: Error) => e);

		for (const error of [...errors, timeout]) {
			expect((error as Error).message).toContain("GET /v3/customers");
			expect((error as Error).message).not.toContain("ref-secret");
		}
		expect(errors[0]).toBeInstanceOf(AsaasOutcomeUnknownError);
		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
	});

	it("customerExists: true for a live customer, false for 404 or deleted, throws on anything else", async () => {
		const exists = (response: Response) =>
			createAsaasClient(settings, vi.fn().mockResolvedValue(response)).customerExists("cus_1");

		expect(await exists(jsonResponse({ id: "cus_1", deleted: false }))).toBe(true);
		expect(await exists(jsonResponse({ id: "cus_1", deleted: true }))).toBe(false);
		expect(await exists(jsonResponse({ errors: [] }, 404))).toBe(false);
		await expect(exists(jsonResponse({}, 403))).rejects.toBeInstanceOf(AsaasHttpError);
		await expect(exists(jsonResponse({}, 502))).rejects.toBeInstanceOf(AsaasOutcomeUnknownError);
	});

	it("cancelPixCharge: DELETE /v3/payments/{id}; 404 counts as done; other errors throw", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true, id: "pay_1" }));
		await createAsaasClient(settings, fetchMock).cancelPixCharge("pay_1");
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/payments/pay_1");
		expect(init.method).toBe("DELETE");

		const cancel = (response: Response) =>
			createAsaasClient(settings, vi.fn().mockResolvedValue(response)).cancelPixCharge("pay_1");
		await expect(cancel(jsonResponse({ errors: [] }, 404))).resolves.toBeUndefined();
		await expect(cancel(jsonResponse({ errors: [] }, 400))).rejects.toBeInstanceOf(AsaasHttpError);
		await expect(cancel(jsonResponse({}, 502))).rejects.toBeInstanceOf(AsaasOutcomeUnknownError);
	});

	it("creates a customer with notifications disabled and returns its id", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "cus_9" }));

		const result = await createAsaasClient(settings, fetchMock).createCustomer({ ...customerInput, externalReference: "pp-1" });

		expect(result).toEqual({ asaasCustomerId: "cus_9" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/customers");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({ ...customerInput, externalReference: "pp-1", notificationDisabled: true });
	});

	it("a timeout while creating a customer is an unknown outcome", async () => {
		const error = await createAsaasClient(settings, vi.fn().mockRejectedValue(new Error("aborted")))
			.createCustomer(customerInput)
			.catch((e: Error) => e);

		expect(error).toBeInstanceOf(AsaasOutcomeUnknownError);
	});

	it("updates a customer with PUT on the customer path", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "cus_9" }));

		await createAsaasClient(settings, fetchMock).updateCustomer("cus_9", { ...customerInput, postalCode: "01310100" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/customers/cus_9");
		expect(init.method).toBe("PUT");
		expect(JSON.parse(init.body)).toMatchObject({ postalCode: "01310100" });
	});
});

describe("createCardCharge", () => {
	it("charges once (value, no installment fields) and returns brand and last4", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(cardReply));

		const result = await createAsaasClient(settings, fetchMock).createCardCharge(cardInput);

		expect(result).toEqual({ asaasPaymentId: "pay_card_1", asaasInstallmentId: null, brand: "VISA", last4: "1111" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/payments");
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			customer: "cus_1",
			billingType: "CREDIT_CARD",
			value: 105,
			externalReference: "ref-card-1",
			remoteIp: "203.0.113.9",
			creditCard: { number: CARD_NUMBER, ccv: CCV },
			creditCardHolderInfo: { cpfCnpj: DOCUMENT, postalCode: "01310100", phone: "11999994321" },
		});
		expect(body).not.toHaveProperty("installmentCount");
		expect(body).not.toHaveProperty("totalValue");
	});

	it("sends installmentCount and totalValue (no value) for 3 installments and returns the installment id", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ...cardReply, installment: "ins_1" }));

		const result = await createAsaasClient(settings, fetchMock).createCardCharge({
			...cardInput,
			totalCents: 10_333,
			installments: 3,
			installmentCents: 3_445,
		});

		expect(result.asaasInstallmentId).toBe("ins_1");
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body).toMatchObject({ installmentCount: 3, totalValue: 103.33 });
		expect(body).not.toHaveProperty("value");
	});

	it("falls back to the typed last4 when the reply has no card data", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "pay_card_2" }));

		const result = await createAsaasClient(settings, fetchMock).createCardCharge(cardInput);

		expect(result).toEqual({ asaasPaymentId: "pay_card_2", asaasInstallmentId: null, brand: "UNKNOWN", last4: "1111" });
	});

	it("turns HTTP 400 into CardDeclinedError with a fixed safe message", async () => {
		const body = { errors: [{ code: "invalid_creditCard", description: `Cartão ${CARD_NUMBER} cvv ${CCV} ${DOCUMENT}` }] };
		const error = await createAsaasClient(settings, vi.fn().mockResolvedValue(jsonResponse(body, 400)))
			.createCardCharge(cardInput)
			.catch((e: Error) => e);

		expect(error).toBeInstanceOf(CardDeclinedError);
		for (const secret of [CARD_NUMBER, CCV, DOCUMENT, "secret-key"]) expect((error as Error).message).not.toContain(secret);
	});

	it("keeps other 4xx as plain errors and 5xx, 408, 429, timeout as unknown outcome", async () => {
		const call = (mock: typeof fetch) =>
			createAsaasClient(settings, mock).createCardCharge(cardInput).catch((e: Error) => e);

		const unauthorized = await call(vi.fn().mockResolvedValue(jsonResponse({}, 401)));
		expect(unauthorized).not.toBeInstanceOf(CardDeclinedError);
		expect(unauthorized).not.toBeInstanceOf(AsaasOutcomeUnknownError);
		expect((unauthorized as Error).message).toBe("Asaas respondeu 401 em POST /v3/payments");
		for (const status of [500, 408, 429]) {
			expect(await call(vi.fn().mockResolvedValue(jsonResponse({}, status)))).toBeInstanceOf(AsaasOutcomeUnknownError);
		}
		expect(await call(vi.fn().mockRejectedValue(new Error(`boom ${CARD_NUMBER}`)))).toBeInstanceOf(AsaasOutcomeUnknownError);
	});

	it("never logs or leaks card number, CVV or CPF, even when the reply is unreadable", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
		const errors = [
			await createAsaasClient(settings, vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })))
				.createCardCharge(cardInput)
				.catch((e: Error) => e),
			await createAsaasClient(settings, vi.fn().mockRejectedValue(new Error(`boom ${CARD_NUMBER} ${CCV}`)))
				.createCardCharge(cardInput)
				.catch((e: Error) => e),
		];

		for (const error of errors) {
			expect(error).toBeInstanceOf(AsaasOutcomeUnknownError);
			for (const secret of [CARD_NUMBER, CCV, DOCUMENT]) expect((error as Error).message).not.toContain(secret);
		}
		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
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

	it("sends the installment id instead of the payment for an installment charge", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "inv_2" }));

		await createAsaasClient(settings, fetchMock).scheduleInvoice({ ...invoiceInput, installmentId: "ins_1" });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.installment).toBe("ins_1");
		expect(body).not.toHaveProperty("payment");
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

describe("findInvoicesByPayment", () => {
	it("GETs /v3/invoices?payment= without a body and drops ERROR and CANCELED notes", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				data: [
					{ id: "inv_err", status: "ERROR" },
					{ id: "inv_can", status: "CANCELED" },
					{ id: "inv_ok", status: "AUTHORIZED", number: 12, pdfUrl: "https://nfse.example/12.pdf" },
				],
			}),
		);

		const result = await createAsaasClient(settings, fetchMock).findInvoicesByPayment("pay_1");

		expect(result).toEqual([
			{ asaasInvoiceId: "inv_ok", status: "AUTHORIZED", number: "12", pdfUrl: "https://nfse.example/12.pdf" },
		]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.asaas.example/v3/invoices?payment=pay_1&limit=100");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	});
});

describe("unknown outcome", () => {
	it("a timeout or network failure is an unknown outcome, not a plain failure", async () => {
		const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));

		const error = await createAsaasClient(settings, fetchMock).scheduleInvoice(invoiceInput).catch((e: Error) => e);

		expect(error).toBeInstanceOf(AsaasOutcomeUnknownError);
		expect((error as Error).message).not.toContain("secret-key");
	});

	it("a 5xx, 408, 429 or an unreadable 2xx is an unknown outcome; another 4xx is not", async () => {
		const call = (response: Response) =>
			createAsaasClient(settings, vi.fn().mockResolvedValue(response)).scheduleInvoice(invoiceInput).catch((e: Error) => e);

		expect(await call(jsonResponse({}, 502))).toBeInstanceOf(AsaasOutcomeUnknownError);
		expect(await call(jsonResponse({}, 408))).toBeInstanceOf(AsaasOutcomeUnknownError);
		expect(await call(jsonResponse({}, 429))).toBeInstanceOf(AsaasOutcomeUnknownError);
		expect(await call(jsonResponse({}))).toBeInstanceOf(AsaasOutcomeUnknownError);
		expect(await call(jsonResponse({}, 400))).not.toBeInstanceOf(AsaasOutcomeUnknownError);
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

	it("finds a customer by external reference, never by document, and skips deleted ones", async () => {
		resetFakeCustomers();
		const fake = createFakeAsaasClient();
		const stranger = { name: "Outra Pessoa", cpfCnpj: DOCUMENT, email: "outra@example.test" };

		expect(await fake.findCustomerByExternalReference("pp-1")).toBeNull();
		const other = await fake.createCustomer({ ...stranger, externalReference: "someone-else" });
		const mine = await fake.createCustomer({ ...stranger, name: "Maria", externalReference: "pp-1" });

		expect(mine.asaasCustomerId).not.toBe(other.asaasCustomerId);
		expect(await fake.findCustomerByExternalReference("pp-1")).toBe(mine.asaasCustomerId);
		deleteFakeCustomer(mine.asaasCustomerId);
		expect(await fake.findCustomerByExternalReference("pp-1")).toBeNull();
		expect(await fake.customerExists(mine.asaasCustomerId)).toBe(false);
		expect(await fake.customerExists(other.asaasCustomerId)).toBe(true);
		await expect(fake.updateCustomer(mine.asaasCustomerId, stranger)).rejects.toBeInstanceOf(AsaasHttpError);
		expect(getFakeCustomer(other.asaasCustomerId)?.name).toBe("Outra Pessoa");
	});

	it("finds invoices of an installment apart from the invoices of a payment", async () => {
		resetFakeInvoices();
		const fake = createFakeAsaasClient();

		expect(await fake.findInvoicesByInstallment("ins_1")).toEqual([]);
		await fake.scheduleInvoice({ ...invoiceInput, installmentId: "ins_1" });

		expect(await fake.findInvoicesByInstallment("ins_1")).toHaveLength(1);
		expect(await fake.findInvoicesByPayment(invoiceInput.paymentId)).toEqual([]);
	});

	it("declines a card ending in 0002 and returns an installment id for 2+ installments", async () => {
		const fake = createFakeAsaasClient();
		const withNumber = (number: string, installments: number) => ({
			...cardInput,
			installments,
			card: { ...cardInput.card, number },
		});

		await expect(fake.createCardCharge(withNumber("4000000000000002", 1))).rejects.toBeInstanceOf(CardDeclinedError);
		expect(await fake.createCardCharge(withNumber(CARD_NUMBER, 1))).toMatchObject({ asaasInstallmentId: null, last4: "1111" });
		expect((await fake.createCardCharge(withNumber(CARD_NUMBER, 3))).asaasInstallmentId).toBe("ins_fake_ref-card-1");
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

	it("adds the installment id to the payment webhook body", () => {
		expect(
			buildFakePaymentEvent({ eventId: "e", asaasPaymentId: "pay_1", value: 10, installment: "ins_1" }).payment.installment,
		).toBe("ins_1");
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
