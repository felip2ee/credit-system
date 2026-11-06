import type { NfseConfig } from "@/lib/config";

export type PixChargeInput = {
	// Cliente Asaas do pagador (cus_...).
	customerId: string;
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

export type AsaasCustomerInput = {
	name: string;
	cpfCnpj: string;
	email: string;
	mobilePhone?: string;
	postalCode?: string;
	addressNumber?: string;
};

// Dados do cartão só passam por aqui, em memória: nunca em log, erro ou banco.
export type CardChargeInput = {
	customerId: string;
	externalReference: string;
	description: string;
	// Total cobrado do pagador (recarga + taxa), em centavos.
	totalCents: number;
	installments: number;
	installmentCents: number;
	card: { holderName: string; number: string; expiryMonth: string; expiryYear: string; ccv: string };
	holder: { name: string; email: string; cpfCnpj: string; postalCode: string; addressNumber: string; phone: string };
	remoteIp: string;
};

export type CardChargeResult = {
	asaasPaymentId: string;
	// Só com 2 ou mais parcelas.
	asaasInstallmentId: string | null;
	brand: string;
	last4: string;
};

export type InvoiceInput = {
	// Pagamento do Asaas já confirmado; a nota nasce dele.
	paymentId: string;
	// Reais, string decimal com até 2 casas (o valor da cobrança no banco).
	amount: string;
	// Nossa referência (id da cobrança).
	externalReference: string;
	// Cobrança parcelada: a nota nasce do parcelamento inteiro e vai no lugar de `paymentId`.
	installmentId?: string;
	service: NfseConfig;
};

export type InvoiceResult = { asaasInvoiceId: string };

// Nota que o Asaas já tem para um pagamento (sem as descartadas: ERROR e CANCELED).
export type ExistingInvoice = {
	asaasInvoiceId: string;
	status: string | null;
	number: string | null;
	pdfUrl: string | null;
};

export type AsaasClient = {
	createPixCharge(input: PixChargeInput): Promise<PixChargeResult>;
	// GET /v3/customers?cpfCnpj=: id do cliente mais antigo não apagado, ou null. Nunca devolve os dados dele.
	findCustomerByCpfCnpj(cpfCnpj: string): Promise<string | null>;
	// Não é idempotente: após AsaasOutcomeUnknownError, busque por CPF/CNPJ antes de criar de novo.
	createCustomer(input: AsaasCustomerInput & { externalReference?: string }): Promise<{ asaasCustomerId: string }>;
	updateCustomer(asaasCustomerId: string, input: AsaasCustomerInput): Promise<void>;
	// Lança CardDeclinedError na recusa. O crédito vem só do webhook.
	createCardCharge(input: CardChargeInput): Promise<CardChargeResult>;
	// Agenda a NFS-e. Agendar não é emitir: a emissão chega depois pelo evento INVOICE_AUTHORIZED.
	scheduleInvoice(input: InvoiceInput): Promise<InvoiceResult>;
	// POST /v3/invoices não é idempotente: antes de agendar, consulte as notas que o pagamento já tem.
	findInvoicesByPayment(paymentId: string): Promise<ExistingInvoice[]>;
};
