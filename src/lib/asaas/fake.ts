import {
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_CANCELED,
	ASAAS_EVENT_INVOICE_ERROR,
	ASAAS_EVENT_PAYMENT_RECEIVED,
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
}) {
	return {
		id: input.eventId,
		event: input.event ?? ASAAS_EVENT_PAYMENT_RECEIVED,
		payment: {
			object: "payment",
			id: input.asaasPaymentId,
			value: input.value,
			...(input.externalReference ? { externalReference: input.externalReference } : {}),
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
