export type AnonymizeHolderFailure = "not_found" | "already_anonymized" | "open_orders";
export type AnonymizeClientFailure = "not_found" | "already_anonymized" | "balance" | "open_orders";

export type AnonymizeHolderResult = { ok: true } | { ok: false; reason: AnonymizeHolderFailure };
export type AnonymizeClientResult = { ok: true } | { ok: false; reason: AnonymizeClientFailure };

export type AnonymizeInput = { reason: string };

// Contagens por tabela devolvidas pelas funções de varredura.
export type PurgeCounts = Record<string, number>;

type Row = Record<string, unknown>;

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
	exportedAt: string;
};
