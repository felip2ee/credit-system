// Cliente HTTP do Asaas. Conferido em 2026-10-14 na documentação pública (docs.asaas.com), sem sandbox:
// POST /v3/payments (customer, billingType=PIX, value, dueDate, externalReference) com o header `access_token`;
// GET /v3/payments/{id}/pixQrCode -> { encodedImage, payload }; webhook com o header `asaas-access-token`
// (o authToken do webhook) e corpo { id, event, payment: { id, value } }.
// Não conferido: que a cobrança PIX sem customer próprio aceita um customer único da conta (ASAAS_CUSTOMER_ID).
// Prova real: item (post-deploy) da spec.
//
// NFS-e, conferido em 2026-10-14 em docs.asaas.com (agendar nota fiscal; webhooks de notas fiscais):
// POST /v3/invoices { payment, municipalServiceId | municipalServiceCode, municipalServiceName, serviceDescription,
// value, effectiveDate, externalReference, observations, deductions, taxes } -> { id, status, number, pdfUrl };
// status SCHEDULED | AUTHORIZED | PROCESSING_CANCELLATION | CANCELED | CANCELLATION_DENIED | ERROR; agendar não emite.
// Eventos INVOICE_CREATED | UPDATED | SYNCHRONIZED | AUTHORIZED | PROCESSING_CANCELLATION | CANCELED |
// CANCELLATION_DENIED | ERROR, corpo { id, event, invoice: { id, status, number, pdfUrl, payment } }; entrega "at least once".
// Não conferido: quais subcampos de `taxes` cada prefeitura exige (enviamos retainIss e iss), se `observations` pode
// ir vazio, se o id municipal serve a toda prefeitura (há o código como alternativa) e se `invoice.externalReference`
// vem nos eventos (por isso o webhook casa a nota pela cobrança, `invoice.payment`). Prova real: item (post-deploy).
import { z } from "zod";

import type { AsaasClient, ExistingInvoice, InvoiceInput, InvoiceResult, PixChargeInput, PixChargeResult } from "./types";

export const ASAAS_API_KEY_HEADER = "access_token";
export const ASAAS_WEBHOOK_TOKEN_HEADER = "asaas-access-token";
export const ASAAS_EVENT_PAYMENT_RECEIVED = "PAYMENT_RECEIVED";
export const ASAAS_EVENT_PAYMENT_CONFIRMED = "PAYMENT_CONFIRMED";
export const ASAAS_EVENT_PAYMENT_REFUNDED = "PAYMENT_REFUNDED";
export const ASAAS_INVOICE_EVENT_PREFIX = "INVOICE_";
export const ASAAS_EVENT_INVOICE_AUTHORIZED = "INVOICE_AUTHORIZED";
export const ASAAS_EVENT_INVOICE_ERROR = "INVOICE_ERROR";
export const ASAAS_EVENT_INVOICE_CANCELED = "INVOICE_CANCELED";

const REQUEST_TIMEOUT_MS = 15_000;

// O pedido pode ter chegado ao Asaas: timeout, falha de rede, 5xx ou resposta 2xx ilegível. Quem escreve (POST) não
// pode tratar isto como falha: repetir cria outra nota. Primeiro consulte o Asaas.
export class AsaasOutcomeUnknownError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AsaasOutcomeUnknownError";
	}
}

export type AsaasClientSettings = { apiKey: string; baseUrl: string; customerId: string };

const paymentSchema = z.object({ id: z.string().min(1) });
const invoiceSchema = z.object({ id: z.string().min(1) });
// Lista de notas (GET /v3/invoices?payment=): só o que a adoção da nota precisa.
const invoiceListSchema = z.object({
	data: z.array(
		z.object({
			id: z.string().min(1),
			status: z.string().nullish(),
			number: z.union([z.string(), z.number()]).nullish(),
			pdfUrl: z.string().nullish(),
		}),
	),
});
// ERROR e CANCELED foram descartadas: uma nova tentativa legítima pode criar outra nota.
const DISCARDED_INVOICE_STATUSES = new Set(["ERROR", "CANCELED"]);
const qrSchema = z.object({ encodedImage: z.string().min(1), payload: z.string().min(1) });

// Vencimento no fuso de Brasília (a data é local ao negócio, não UTC).
function todayInSaoPaulo(): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export function createAsaasClient(settings: AsaasClientSettings, fetchImpl: typeof fetch = fetch): AsaasClient {
	const base = settings.baseUrl.replace(/\/+$/, "");

	// Erros levam só método, caminho e status: nunca a chave nem o corpo da resposta.
	async function call<T>(
		method: "GET" | "POST",
		path: string,
		label: string,
		schema: z.ZodType<T>,
		body?: unknown,
	): Promise<T> {
		let response: Response;
		try {
			response = await fetchImpl(`${base}${path}`, {
				method,
				headers: { [ASAAS_API_KEY_HEADER]: settings.apiKey, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new AsaasOutcomeUnknownError(`Sem resposta do Asaas em ${label} (${error instanceof Error ? error.name : typeof error})`);
		}
		// 408 e 429 são transitórios: tratados como 5xx (resultado desconhecido, tentável de novo), não como erro definitivo.
		if (response.status >= 500 || response.status === 408 || response.status === 429)
			throw new AsaasOutcomeUnknownError(`Asaas respondeu ${response.status} em ${label}`);
		if (!response.ok) throw new Error(`Asaas respondeu ${response.status} em ${label}`);
		const parsed = schema.safeParse(await response.json().catch(() => null));
		if (!parsed.success) throw new AsaasOutcomeUnknownError(`Resposta inválida do Asaas em ${label}`);
		return parsed.data;
	}

	return {
		async createPixCharge(input: PixChargeInput): Promise<PixChargeResult> {
			const payment = await call("POST", "/v3/payments", "POST /v3/payments", paymentSchema, {
				customer: settings.customerId,
				billingType: "PIX",
				// Serialização do valor já validado (2 casas); nenhuma conta em ponto flutuante.
				value: Number(input.amount),
				dueDate: todayInSaoPaulo(),
				externalReference: input.externalReference,
				description: input.description,
			});
			const qr = await call(
				"GET",
				`/v3/payments/${encodeURIComponent(payment.id)}/pixQrCode`,
				"GET /v3/payments/{id}/pixQrCode",
				qrSchema,
			);
			return { asaasPaymentId: payment.id, pixPayload: qr.payload, qrImageBase64: qr.encodedImage };
		},

		async scheduleInvoice(input: InvoiceInput): Promise<InvoiceResult> {
			const { service } = input;
			const invoice = await call("POST", "/v3/invoices", "POST /v3/invoices", invoiceSchema, {
				payment: input.paymentId,
				...(service.municipalServiceId
					? { municipalServiceId: service.municipalServiceId }
					: { municipalServiceCode: service.municipalServiceCode }),
				municipalServiceName: service.municipalServiceName,
				serviceDescription: service.serviceDescription,
				// Valor da cobrança no banco (2 casas); nenhuma conta em ponto flutuante.
				value: Number(input.amount),
				deductions: 0,
				effectiveDate: todayInSaoPaulo(),
				observations: "",
				externalReference: input.externalReference,
				taxes: { retainIss: service.retainIss, iss: service.issRate },
			});
			return { asaasInvoiceId: invoice.id };
		},

		// GET /v3/invoices?payment={id} (docs.asaas.com, listar notas fiscais; o corpo da requisição deve ficar vazio).
		async findInvoicesByPayment(paymentId: string): Promise<ExistingInvoice[]> {
			const list = await call(
				"GET",
				`/v3/invoices?payment=${encodeURIComponent(paymentId)}&limit=100`,
				"GET /v3/invoices",
				invoiceListSchema,
			);
			return list.data
				.filter((invoice) => !DISCARDED_INVOICE_STATUSES.has(invoice.status ?? ""))
				.map((invoice) => ({
					asaasInvoiceId: invoice.id,
					status: invoice.status ?? null,
					number: invoice.number === null || invoice.number === undefined ? null : String(invoice.number),
					pdfUrl: invoice.pdfUrl ?? null,
				}));
		},
	};
}
