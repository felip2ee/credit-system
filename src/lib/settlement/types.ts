import type { Quote } from "@/lib/catalog/quote";

// Resultado de quoteOrder (M2) sem o ramo de falha.
export type OrderQuote = Extract<Quote, { ok: true }>;

export type SettlementMode = "online" | "counter";
export type SettlementStatus = "reserved" | "captured" | "released";

export type SettlementFailure =
	| "not_found"
	| "not_allowed"
	| "invalid_state"
	| "insufficient_balance"
	| "price_below_cost"
	| "invalid_amount"
	| "already_exists";

export type SettlementResult =
	| { ok: true; status: SettlementStatus }
	| { ok: false; reason: SettlementFailure };

export type ReserveOrderInput = {
	orderRef: string;
	mode: SettlementMode;
	// Online: o id do próprio cliente. Balcão: null.
	clientProfileId: string | null;
	quote: OrderQuote;
};

export type Settlement = {
	id: string;
	orderRef: string;
	bureauId: string;
	mode: SettlementMode;
	clientProfileId: string | null;
	price: string;
	cost: string;
	quote: { lines: OrderQuote["lines"] };
	status: SettlementStatus;
	createdAt: Date;
	closedAt: Date | null;
};
