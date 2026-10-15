import {
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_ERROR,
	ASAAS_EVENT_PAYMENT_RECEIVED,
} from "./client";
import type { AsaasClient } from "./types";

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
		async scheduleInvoice({ externalReference }) {
			return { asaasInvoiceId: `inv_fake_${externalReference}` };
		},
	};
}

// Corpo de um evento de pagamento do Asaas, para simular o webhook nos testes.
export function buildFakePaymentEvent(input: {
	eventId: string;
	asaasPaymentId: string;
	value: number;
	event?: string;
}) {
	return {
		id: input.eventId,
		event: input.event ?? ASAAS_EVENT_PAYMENT_RECEIVED,
		payment: { object: "payment", id: input.asaasPaymentId, value: input.value },
	};
}

// Corpo de um evento de nota do Asaas (formato conferido em docs.asaas.com), para simular o webhook nos testes.
export function buildFakeInvoiceEvent(input: {
	eventId: string;
	event: typeof ASAAS_EVENT_INVOICE_AUTHORIZED | typeof ASAAS_EVENT_INVOICE_ERROR;
	asaasPaymentId: string;
	number?: string;
	pdfUrl?: string;
}) {
	return {
		id: input.eventId,
		event: input.event,
		invoice: {
			object: "invoice",
			id: `inv_fake_${input.asaasPaymentId}`,
			status: input.event === ASAAS_EVENT_INVOICE_AUTHORIZED ? "AUTHORIZED" : "ERROR",
			payment: input.asaasPaymentId,
			number: input.number ?? null,
			pdfUrl: input.pdfUrl ?? null,
		},
	};
}
