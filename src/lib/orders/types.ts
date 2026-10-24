// Pedido de pesquisa (M6): tipos e limites. O estado é protegido pelo gatilho dossier_orders_guard (022).
export type OrderMode = "online" | "counter";
export type OrderState =
	| "awaiting_payment"
	| "awaiting_authorization"
	| "ready"
	| "executing"
	| "completed"
	| "released"
	| "failed"
	| "cancelled";
export type OrderStateReason =
	| "scr_refused"
	| "scr_expired"
	| "payment_timeout"
	| "cancelled_by_staff"
	| "deps_no_data"
	| "deps_incompatible"
	| "deps_unavailable"
	| "reservation_clawed_back";
export type AiStatus = "none" | "pending" | "done" | "failed";
export type OrderProductCode = "dossie_pf" | "dossie_empresarial";
export type OrderKind = "PF" | "PJ" | "PJ_FULL";
export type OpenOrderFailure =
	| "not_allowed"
	| "invalid_input"
	| "product_not_for_sale"
	| "kind_mismatch"
	| "third_party_not_allowed"
	| "self_holder_missing"
	| "contact_is_buyer"
	| "buyer_not_found"
	| "too_many_requests";
export type OpenOrderInput = {
	productCode: OrderProductCode;
	self: boolean;
	subject: { type: "PF" | "PJ"; name: string; documentDigits: string } | null;
	partners: {
		documentDigits: string;
		name: string | null;
		email: string | null;
		percentage: number | null;
		role: string | null;
	}[];
	contact: { email: string | null; phoneE164: string | null };
	buyerProfileId: string | null;
};

export const MAX_EXECUTION_ATTEMPTS = 5;
export const MAX_AI_ATTEMPTS = 3;
export const LEASE_MINUTES = 5;
export const PAYMENT_WINDOW_DAYS = 7;
// Prazo do pedido de autorização SCR, contado da criação do pedido (igual ao da 022: open_order e emissão).
export const SCR_REQUEST_DAYS = 7;
