// Regras puras da lista de pagamentos: forma de pagamento e situação de cada pedido.
export const PAYMENT_FILTERS = ["all", "client", "counter"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];

export const PAYMENT_FILTER_LABEL: Record<PaymentFilter, string> = {
	all: "Todos",
	client: "Saldo do cliente",
	counter: "Balcão",
};

// Lista de permissão: qualquer outro valor vira "all".
export function parsePaymentFilter(raw: string | undefined): PaymentFilter {
	return PAYMENT_FILTERS.find((f) => f === raw) ?? "all";
}

export type PaymentMethodKind = "client_balance" | "counter";
export type PaymentState = "paid" | "awaiting" | "cancelled" | "refunded";

export function paymentMethodLabel(mode: "online" | "counter"): { kind: PaymentMethodKind; label: string } {
	return mode === "online"
		? { kind: "client_balance", label: "Saldo do cliente (app)" }
		: { kind: "counter", label: "Balcão" };
}

type StateInput = {
	mode: "online" | "counter";
	orderState: string;
	settlementStatus: "reserved" | "captured" | "released" | null;
	price: string | null;
	paidTotal: string;
};

// Valores em centavos inteiros para não errar a comparação de decimais.
const cents = (v: string) => Math.round(Number(v) * 100);

export function derivePaymentState(i: StateInput): PaymentState {
	if (i.settlementStatus === "released") return i.mode === "online" ? "refunded" : "cancelled";
	if (i.orderState === "cancelled") return "cancelled";
	// Online: o saldo fica reservado na criação do pedido, então reservado ou cobrado já é pago.
	if (i.mode === "online") return i.settlementStatus ? "paid" : "awaiting";
	return i.price !== null && cents(i.paidTotal) >= cents(i.price) ? "paid" : "awaiting";
}
