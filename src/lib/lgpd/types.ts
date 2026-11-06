export type AnonymizeHolderFailure = "not_found" | "already_anonymized" | "client_active" | "open_orders";
export type AnonymizeClientFailure = "not_found" | "already_anonymized" | "balance" | "commission" | "open_orders";

export type AnonymizeHolderResult = { ok: true } | { ok: false; reason: AnonymizeHolderFailure };
export type AnonymizeClientResult = { ok: true } | { ok: false; reason: AnonymizeClientFailure };

export type AnonymizeInput = { reason: string };

// Contagens por tabela devolvidas pelas funções de varredura.
export type PurgeCounts = Record<string, number>;

type Row = Record<string, unknown>;

// Dados de pagamento do Titular com conta de cliente (payer_profiles): só máscaras, nunca o blob cifrado.
export type PaymentDataExport = {
	documentMasked: string | null;
	postalCodeMasked: string | null;
	hasAddressNumber: boolean;
	asaasCustomerLinked: boolean;
};

// Exportação do Titular. Fica de fora: auth_code, public_token e consent_ip das autorizações SCR.
export type HolderExport = {
	holder: Row;
	partnerships: Row[];
	dossiers: Row[];
	consultations: (Row & { result: Row | null; aiReport: Row | null })[];
	scrAuthorizations: Row[];
	orders: Row[];
	timeline: Row[];
	notes: Row[];
	// Nulo: Titular sem conta de cliente, sem dados de pagamento, ou linha que a identidade não enxerga (RLS).
	paymentData: PaymentDataExport | null;
	exportedAt: string;
};
