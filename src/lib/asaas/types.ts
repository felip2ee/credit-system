import type { NfseConfig } from "@/lib/config";

export type PixChargeInput = {
	// Reais, string decimal com até 2 casas.
	amount: string;
	// Referência nossa, devolvida pelo Asaas; não é a chave de busca do webhook.
	externalReference: string;
	description: string;
};

// asaasPaymentId fica no servidor: nunca vai ao navegador.
export type PixChargeResult = {
	asaasPaymentId: string;
	pixPayload: string;
	qrImageBase64: string;
};

export type InvoiceInput = {
	// Pagamento do Asaas já confirmado; a nota nasce dele.
	paymentId: string;
	// Reais, string decimal com até 2 casas (o valor da cobrança no banco).
	amount: string;
	// Nossa referência (id da cobrança).
	externalReference: string;
	service: NfseConfig;
};

export type InvoiceResult = { asaasInvoiceId: string };

export type AsaasClient = {
	createPixCharge(input: PixChargeInput): Promise<PixChargeResult>;
	// Agenda a NFS-e. Agendar não é emitir: a emissão chega depois pelo evento INVOICE_AUTHORIZED.
	scheduleInvoice(input: InvoiceInput): Promise<InvoiceResult>;
};
