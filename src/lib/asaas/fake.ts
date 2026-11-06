import {
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_CANCELED,
	ASAAS_EVENT_INVOICE_ERROR,
	ASAAS_EVENT_PAYMENT_RECEIVED,
	CardDeclinedError,
} from "./client";
import type { AsaasClient, ExistingInvoice } from "./types";

// Notas agendadas, por pagamento: o fake responde à consulta de notas como o Asaas (estado do processo, só para testes).
const scheduledInvoices = new Map<string, ExistingInvoice[]>();
export const resetFakeInvoices = (): void => scheduledInvoices.clear();
// Espelha no fake o que o Asaas faria com a nota (ERROR, CANCELED...): o fake não vê os webhooks.
export function setFakeInvoiceStatus(paymentId: string, status: string): void {
	scheduledInvoices.set(
		paymentId,
		(scheduledInvoices.get(paymentId) ?? []).map((invoice) => ({ ...invoice, status })),
	);
}

// Clientes por documento (só dígitos): o fake acha o cliente como o Asaas acharia. Estado do processo, só para testes.
const fakeCustomers = new Map<string, string>();
export const resetFakeCustomers = (): void => fakeCustomers.clear();
// Número de teste que o fake recusa, como o Asaas faria com um cartão não autorizado.
export const FAKE_DECLINED_CARD_LAST4 = "0002";

// Ids derivados da externalReference: o mesmo pedido gera o mesmo resultado.
export function createFakeAsaasClient(): AsaasClient {
	return {
		async createPixCharge({ externalReference }) {
			return {
				asaasPaymentId: `pay_fake_${externalReference}`,
				pixPayload: `00020126fake-pix-${externalReference}`,
				qrImageBase64: Buffer.from(`fake-qr-${externalReference}`).toString("base64"),
			};
		},
		async findCustomerByCpfCnpj(cpfCnpj) {
			return fakeCustomers.get(cpfCnpj.replace(/\D/g, "")) ?? null;
		},
		async createCustomer({ cpfCnpj }) {
			const document = cpfCnpj.replace(/\D/g, "");
			const asaasCustomerId = `cus_fake_${fakeCustomers.size + 1}`;
			// Como no Asaas, criar de novo não apaga o mais antigo: a busca devolve o primeiro.
			if (!fakeCustomers.has(document)) fakeCustomers.set(document, asaasCustomerId);
			return { asaasCustomerId };
		},
		async updateCustomer() {},
		async createCardCharge({ externalReference, installments, card }) {
			const last4 = card.number.replace(/\D/g, "").slice(-4);
			if (last4 === FAKE_DECLINED_CARD_LAST4) throw new CardDeclinedError();
			return {
				asaasPaymentId: `pay_fake_${externalReference}`,
				asaasInstallmentId: installments >= 2 ? `ins_fake_${externalReference}` : null,
				brand: "VISA",
				last4,
			};
		},
		async scheduleInvoice({ externalReference, paymentId }) {
			const asaasInvoiceId = `inv_fake_${externalReference}`;
			scheduledInvoices.set(paymentId, [
				...(scheduledInvoices.get(paymentId) ?? []),
				{ asaasInvoiceId, status: "SCHEDULED", number: null, pdfUrl: null },
			]);
			return { asaasInvoiceId };
		},
		async findInvoicesByPayment(paymentId) {
			// Como o cliente real: notas em ERROR ou CANCELED não contam.
			return (scheduledInvoices.get(paymentId) ?? []).filter((i) => i.status !== "ERROR" && i.status !== "CANCELED");
		},
	};
}

// Corpo de um evento de pagamento do Asaas, para simular o webhook nos testes.
export function buildFakePaymentEvent(input: {
	eventId: string;
	asaasPaymentId: string;
	value: number;
	event?: string;
	externalReference?: string;
	installment?: string;
}) {
	return {
		id: input.eventId,
		event: input.event ?? ASAAS_EVENT_PAYMENT_RECEIVED,
		payment: {
			object: "payment",
			id: input.asaasPaymentId,
			value: input.value,
			...(input.externalReference ? { externalReference: input.externalReference } : {}),
		...(input.installment ? { installment: input.installment } : {}),
		},
	};
}

// Corpo de um evento de nota do Asaas (formato conferido em docs.asaas.com), para simular o webhook nos testes.
export function buildFakeInvoiceEvent(input: {
	eventId: string;
	event: typeof ASAAS_EVENT_INVOICE_AUTHORIZED | typeof ASAAS_EVENT_INVOICE_ERROR | typeof ASAAS_EVENT_INVOICE_CANCELED;
	asaasPaymentId: string;
	invoiceId?: string;
	number?: string;
	pdfUrl?: string;
}) {
	return {
		id: input.eventId,
		event: input.event,
		invoice: {
			object: "invoice",
			id: input.invoiceId ?? `inv_fake_${input.asaasPaymentId}`,
			status: input.event.replace("INVOICE_", ""),
			payment: input.asaasPaymentId,
			number: input.number ?? null,
			pdfUrl: input.pdfUrl ?? null,
		},
	};
}
