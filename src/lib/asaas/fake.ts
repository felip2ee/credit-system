import {
	AsaasHttpError,
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_CANCELED,
	ASAAS_EVENT_INVOICE_ERROR,
	ASAAS_EVENT_PAYMENT_RECEIVED,
	CardDeclinedError,
} from "./client";
import type { AsaasClient, AsaasCustomerInput, ExistingInvoice } from "./types";

// Notas agendadas, por pagamento (ou `installment:<id>` no parcelamento): o fake responde à consulta de notas como o Asaas (estado do processo, só para testes).
const scheduledInvoices = new Map<string, ExistingInvoice[]>();
const installmentKey = (installmentId: string): string => `installment:${installmentId}`;
export const resetFakeInvoices = (): void => scheduledInvoices.clear();
// Espelha no fake o que o Asaas faria com a nota (ERROR, CANCELED...): o fake não vê os webhooks.
export function setFakeInvoiceStatus(paymentId: string, status: string): void {
	scheduledInvoices.set(
		paymentId,
		(scheduledInvoices.get(paymentId) ?? []).map((invoice) => ({ ...invoice, status })),
	);
}

// Clientes do fake, por id. Estado do processo, só para testes. Como no Asaas, vários clientes podem ter o mesmo CPF.
type FakeCustomer = AsaasCustomerInput & { externalReference: string | null; deleted: boolean };
const fakeCustomers = new Map<string, FakeCustomer>();
export const resetFakeCustomers = (): void => fakeCustomers.clear();
export const getFakeCustomer = (id: string): FakeCustomer | undefined => fakeCustomers.get(id);
// Apaga o cliente no Asaas: a busca o ignora, a atualização dá 404 e a cobrança com ele dá 400.
export function deleteFakeCustomer(id: string): void {
	const customer = fakeCustomers.get(id);
	if (customer) fakeCustomers.set(id, { ...customer, deleted: true });
}
const isDeleted = (id: string): boolean => fakeCustomers.get(id)?.deleted === true;
// Número de teste que o fake recusa, como o Asaas faria com um cartão não autorizado.
export const FAKE_DECLINED_CARD_LAST4 = "0002";

// Ids derivados da externalReference: o mesmo pedido gera o mesmo resultado.
export function createFakeAsaasClient(): AsaasClient {
	return {
		async createPixCharge({ externalReference, customerId }) {
			if (isDeleted(customerId)) throw new AsaasHttpError(400, "POST /v3/payments");
			return {
				asaasPaymentId: `pay_fake_${externalReference}`,
				pixPayload: `00020126fake-pix-${externalReference}`,
				qrImageBase64: Buffer.from(`fake-qr-${externalReference}`).toString("base64"),
			};
		},
		async findCustomerByExternalReference(externalReference) {
			let found: string | null = null;
			fakeCustomers.forEach((customer, id) => {
				if (found === null && customer.externalReference === externalReference && !customer.deleted) found = id;
			});
			return found;
		},
		async customerExists(asaasCustomerId) {
			const customer = fakeCustomers.get(asaasCustomerId);
			return customer !== undefined && !customer.deleted;
		},
		async createCustomer({ externalReference, ...input }) {
			const asaasCustomerId = `cus_fake_${fakeCustomers.size + 1}`;
			fakeCustomers.set(asaasCustomerId, { ...input, externalReference: externalReference ?? null, deleted: false });
			return { asaasCustomerId };
		},
		async updateCustomer(asaasCustomerId, input) {
			const customer = fakeCustomers.get(asaasCustomerId);
			if (!customer || customer.deleted) throw new AsaasHttpError(404, "PUT /v3/customers/{id}");
			fakeCustomers.set(asaasCustomerId, { ...customer, ...input });
		},
		async createCardCharge({ externalReference, installments, card, customerId }) {
			// O Asaas também responde 400 para cliente apagado: o cliente não distingue isto de uma recusa.
			if (isDeleted(customerId)) throw new CardDeclinedError();
			const last4 = card.number.replace(/\D/g, "").slice(-4);
			if (last4 === FAKE_DECLINED_CARD_LAST4) throw new CardDeclinedError();
			return {
				asaasPaymentId: `pay_fake_${externalReference}`,
				asaasInstallmentId: installments >= 2 ? `ins_fake_${externalReference}` : null,
				brand: "VISA",
				last4,
			};
		},
		async scheduleInvoice({ externalReference, paymentId, installmentId }) {
			const asaasInvoiceId = `inv_fake_${externalReference}`;
			const key = installmentId ? installmentKey(installmentId) : paymentId;
			scheduledInvoices.set(key, [
				...(scheduledInvoices.get(key) ?? []),
				{ asaasInvoiceId, status: "SCHEDULED", number: null, pdfUrl: null },
			]);
			return { asaasInvoiceId };
		},
		async findInvoicesByPayment(paymentId) {
			// Como o cliente real: notas em ERROR ou CANCELED não contam.
			return (scheduledInvoices.get(paymentId) ?? []).filter((i) => i.status !== "ERROR" && i.status !== "CANCELED");
		},
		async findInvoicesByInstallment(installmentId) {
			return (scheduledInvoices.get(installmentKey(installmentId)) ?? []).filter(
				(i) => i.status !== "ERROR" && i.status !== "CANCELED",
			);
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
