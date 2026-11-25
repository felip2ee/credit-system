// Cliente HTTP do Asaas. Conferido em 2026-10-14 na documentação pública (docs.asaas.com), sem sandbox:
// POST /v3/payments (customer, billingType=PIX, value, dueDate, externalReference) com o header `access_token`;
// GET /v3/payments/{id}/pixQrCode -> { encodedImage, payload }; webhook com o header `asaas-access-token`
// (o authToken do webhook) e corpo { id, event, payment: { id, value } }.
//
// Cliente e cartão, conferido em 2026-11-06 em docs.asaas.com (sem sandbox):
// GET /v3/customers?externalReference= -> { data: [{ id, dateCreated, deleted, ... }], hasMore, ... } (limit máx. 100;
// nunca buscamos por cpfCnpj: um CPF digitado por outra pessoa não pode levar ao cliente de um terceiro);
// POST /v3/customers { name, cpfCnpj, email, mobilePhone, postalCode, addressNumber, externalReference,
// notificationDisabled } -> { id }; a atualização é PUT /v3/customers/{id} (todos os campos opcionais; o plano dizia POST);
// POST /v3/payments com billingType=CREDIT_CARD: creditCard { holderName, number, expiryMonth, expiryYear, ccv },
// creditCardHolderInfo { name, email, cpfCnpj, postalCode, addressNumber, phone }, remoteIp (IP do pagador, obrigatório),
// installmentCount + totalValue (o Asaas calcula a parcela) -> { id, installment, creditCard: { creditCardBrand,
// creditCardNumber (4 últimos) } }; cartão não autorizado responde HTTP 400 e a cobrança não é gravada;
// POST /v3/invoices aceita `installment` no lugar de `payment`.
// Não conferido (prova real: itens (post-deploy) da spec):
// - o filtro `installment` de GET /v3/invoices (usado contra a nota duplicada do parcelamento) e o corpo de
//   GET /v3/customers/{id} para um cliente apagado (tratamos 404 e deleted=true como "não existe");
// - a ordem da lista de clientes (ordenamos por dateCreated) e se a lista já exclui apagados (filtramos deleted);
// - se HTTP 400 no cartão é só recusa (dados inválidos também dariam 400; tratamos todo 400 como recusa);
// - como o Asaas arredonda a parcela e onde põe o resto; o formato do webhook de parcelamento;
// - se a conta está habilitada para cartão pela API e se notificationDisabled evita e-mail ao pagador;
// - se a nota por `installment` é aceita pela prefeitura.
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

import type {
	AsaasClient,
	AsaasCustomerInput,
	CardChargeInput,
	CardChargeResult,
	ExistingInvoice,
	InvoiceInput,
	InvoiceResult,
	PixChargeInput,
	PixChargeResult,
} from "./types";

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

// Recusa do cartão (HTTP 400). A mensagem é fixa: nunca leva o corpo do Asaas.
export class CardDeclinedError extends Error {
	constructor() {
		super("Pagamento recusado pelo emissor do cartão. Confira os dados ou use outro cartão.");
		this.name = "CardDeclinedError";
	}
}

// Erro definitivo do Asaas (4xx). Só o status é exposto; a mensagem segue sem corpo.
export class AsaasHttpError extends Error {
	constructor(
		readonly status: number,
		label: string,
	) {
		super(`Asaas respondeu ${status} em ${label}`);
		this.name = "AsaasHttpError";
	}
}

export type AsaasClientSettings = { apiKey: string; baseUrl: string };

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
const customerSchema = z.object({ id: z.string().min(1) });
const customerGetSchema = z.object({ id: z.string().min(1), deleted: z.boolean().nullish() });
const customerListSchema = z.object({
	data: z.array(
		z.object({ id: z.string().min(1), deleted: z.boolean().nullish(), dateCreated: z.string().nullish() }),
	),
});
const cardPaymentSchema = z.object({
	id: z.string().min(1),
	installment: z.string().min(1).nullish(),
	creditCard: z
		.object({ creditCardBrand: z.string().nullish(), creditCardNumber: z.string().nullish() })
		.nullish(),
});
const deletedPaymentSchema = z.object({ id: z.string().min(1).nullish(), deleted: z.boolean().nullish() });
const qrSchema = z.object({ encodedImage: z.string().min(1), payload: z.string().min(1) });

// Vencimento no fuso de Brasília (a data é local ao negócio, não UTC).
// Centavos inteiros para reais com 2 casas, sem acumular erro de ponto flutuante.
const centsToReais = (cents: number): number => Number((cents / 100).toFixed(2));

function todayInSaoPaulo(): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export function createAsaasClient(settings: AsaasClientSettings, fetchImpl: typeof fetch = fetch): AsaasClient {
	const base = settings.baseUrl.replace(/\/+$/, "");

	// Erros levam só método, caminho e status: nunca a chave nem o corpo da resposta.
	async function call<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
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
		if (!response.ok) throw new AsaasHttpError(response.status, label);
		const parsed = schema.safeParse(await response.json().catch(() => null));
		if (!parsed.success) throw new AsaasOutcomeUnknownError(`Resposta inválida do Asaas em ${label}`);
		return parsed.data;
	}

	async function listInvoices(filter: "payment" | "installment", id: string): Promise<ExistingInvoice[]> {
		const list = await call(
			"GET",
			`/v3/invoices?${filter}=${encodeURIComponent(id)}&limit=100`,
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
	}

	return {
		async createPixCharge(input: PixChargeInput): Promise<PixChargeResult> {
			const payment = await call("POST", "/v3/payments", "POST /v3/payments", paymentSchema, {
				customer: input.customerId,
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

		// DELETE /v3/payments/{id} (docs.asaas.com, remover cobrança). Não conferido em sandbox: pagamento já recebido deve
		// responder 4xx (nada é apagado); o webhook segue baixando o que foi pago.
		async cancelPixCharge(asaasPaymentId: string): Promise<void> {
			try {
				await call(
					"DELETE",
					`/v3/payments/${encodeURIComponent(asaasPaymentId)}`,
					"DELETE /v3/payments/{id}",
					deletedPaymentSchema,
				);
			} catch (error) {
				if (error instanceof AsaasHttpError && error.status === 404) return;
				throw error;
			}
		},

		// O rótulo é sempre fixo: a referência vai na URL e nunca pode aparecer em erro. Só o id sai do servidor.
		async findCustomerByExternalReference(externalReference: string): Promise<string | null> {
			const list = await call(
				"GET",
				`/v3/customers?externalReference=${encodeURIComponent(externalReference)}&limit=100`,
				"GET /v3/customers",
				customerListSchema,
			);
			// A ordem da lista não é documentada: o mais antigo não apagado, por dateCreated (AAAA-MM-DD).
			const [oldest] = list.data
				.filter((customer) => customer.deleted !== true)
				.sort((a, b) => (a.dateCreated ?? "").localeCompare(b.dateCreated ?? ""));
			return oldest?.id ?? null;
		},

		async customerExists(asaasCustomerId: string): Promise<boolean> {
			try {
				const customer = await call(
					"GET",
					`/v3/customers/${encodeURIComponent(asaasCustomerId)}`,
					"GET /v3/customers/{id}",
					customerGetSchema,
				);
				return customer.deleted !== true;
			} catch (error) {
				if (error instanceof AsaasHttpError && error.status === 404) return false;
				throw error;
			}
		},

		async createCustomer(input: AsaasCustomerInput & { externalReference?: string }) {
			const customer = await call("POST", "/v3/customers", "POST /v3/customers", customerSchema, {
				...input,
				// A plataforma tem notificações próprias.
				notificationDisabled: true,
			});
			return { asaasCustomerId: customer.id };
		},

		async updateCustomer(asaasCustomerId: string, input: AsaasCustomerInput): Promise<void> {
			await call(
				"PUT",
				`/v3/customers/${encodeURIComponent(asaasCustomerId)}`,
				"PUT /v3/customers/{id}",
				customerSchema,
				input,
			);
		},

		// Sem retry aqui: 5xx/timeout é AsaasOutcomeUnknownError (a cobrança pode existir; o webhook credita).
		async createCardCharge(input: CardChargeInput): Promise<CardChargeResult> {
			const installmentFields =
				input.installments >= 2
					? { installmentCount: input.installments, totalValue: centsToReais(input.totalCents) }
					: { value: centsToReais(input.totalCents) };
			let payment: z.infer<typeof cardPaymentSchema>;
			try {
				payment = await call("POST", "/v3/payments", "POST /v3/payments", cardPaymentSchema, {
					customer: input.customerId,
					billingType: "CREDIT_CARD",
					dueDate: todayInSaoPaulo(),
					externalReference: input.externalReference,
					description: input.description,
					...installmentFields,
					creditCard: input.card,
					creditCardHolderInfo: input.holder,
					remoteIp: input.remoteIp,
				});
			} catch (error) {
				if (error instanceof AsaasHttpError && error.status === 400) throw new CardDeclinedError();
				throw error;
			}
			const returnedLast4 = payment.creditCard?.creditCardNumber ?? "";
			return {
				asaasPaymentId: payment.id,
				asaasInstallmentId: payment.installment ?? null,
				brand: payment.creditCard?.creditCardBrand ?? "UNKNOWN",
				// Cobrança já criada: um campo ausente não pode virar falha. Cai nos 4 últimos que o pagador digitou.
				last4: /^\d{4}$/.test(returnedLast4) ? returnedLast4 : input.card.number.replace(/\D/g, "").slice(-4),
			};
		},

		async scheduleInvoice(input: InvoiceInput): Promise<InvoiceResult> {
			const { service } = input;
			const invoice = await call("POST", "/v3/invoices", "POST /v3/invoices", invoiceSchema, {
				// Parcelamento: uma nota para o parcelamento inteiro (campo `installment`, não conferido na prefeitura).
				...(input.installmentId ? { installment: input.installmentId } : { payment: input.paymentId }),
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
		findInvoicesByPayment: (paymentId: string) => listInvoices("payment", paymentId),

		// Parcelamento: a nota nasce do `installment`. O filtro não foi conferido (veja o cabeçalho).
		findInvoicesByInstallment: (installmentId: string) => listInvoices("installment", installmentId),
	};
}
