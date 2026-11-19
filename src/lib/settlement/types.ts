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
	| "reservation_exceeded"
	| "already_exists"
	| "quote_mismatch"
	| "price_mismatch"
	| "cost_mismatch"
	| "commission_not_configured";

// clawedBack: capture_order não capturou. Um estorno de PIX retomou a reserva e o pedido foi fechado como "released"
// com o que sobrou devolvido. É um sucesso: o fechamento está gravado e o chamador deve confirmar a transação.
export type SettlementResult =
	| { ok: true; status: SettlementStatus; clawedBack?: true }
	| { ok: false; reason: SettlementFailure };

export type ReserveOrderInput = {
	orderRef: string;
	mode: SettlementMode;
	// Online: o id do próprio cliente. Balcão: null.
	clientProfileId: string | null;
	quote: OrderQuote;
};

// Parte da plataforma (preço menos comissão do Bureau; em pedido antigo, o custo de atacado) e cotação por linha: só a
// equipe do Bureau e o superadmin leem.
export type SettlementCost = { cost: string; quote: { lines: OrderQuote["lines"] } };

// O cliente lê preço e status. Para ele, cost e quote vêm null.
export type Settlement = {
	id: string;
	orderRef: string;
	bureauId: string;
	mode: SettlementMode;
	clientProfileId: string | null;
	price: string;
	cost: SettlementCost["cost"] | null;
	quote: SettlementCost["quote"] | null;
	status: SettlementStatus;
	createdAt: Date;
	closedAt: Date | null;
};
