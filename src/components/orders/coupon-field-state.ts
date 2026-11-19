// Estado do campo de cupom, sem React. O total mostrado é só informativo: o banco decide o preço final.
import type { OrderProductCode } from "@/lib/orders/types";

export interface CouponQuoteKey {
	productCode: OrderProductCode;
	partners: number;
}

export interface CouponPreviewValues {
	listCents: number;
	discountCents: number;
	paidCents: number;
}

export type CouponState =
	| { status: "idle" }
	| { status: "applying"; code: string; key: CouponQuoteKey }
	| ({ status: "applied"; code: string; key: CouponQuoteKey } & CouponPreviewValues)
	| { status: "error"; code: string; message: string };

export type CouponAction =
	| { type: "apply"; code: string; key: CouponQuoteKey }
	| { type: "resolved"; code: string; key: CouponQuoteKey; result: { error: string | null } & Partial<CouponPreviewValues> }
	| { type: "remove" }
	| { type: "edit" };

export const IDLE_COUPON: CouponState = { status: "idle" };
const COUPON_FALLBACK_ERROR = "Cupom inválido ou indisponível";

export function normalizeCouponCode(raw: string): string {
	return raw.trim().toUpperCase();
}

export function couponReducer(state: CouponState, action: CouponAction): CouponState {
	switch (action.type) {
		case "apply":
			return action.code ? { status: "applying", code: action.code, key: action.key } : state;
		case "resolved": {
			// Resposta de uma consulta que já foi substituída (outro código ou outra chave) não vale.
			if (state.status !== "applying" || state.code !== action.code || !sameKey(state.key, action.key)) return state;
			const { error, listCents, discountCents, paidCents } = action.result;
			if (error || listCents === undefined || discountCents === undefined || paidCents === undefined) {
				return { status: "error", code: action.code, message: error ?? COUPON_FALLBACK_ERROR };
			}
			return { status: "applied", code: action.code, key: action.key, listCents, discountCents, paidCents };
		}
		case "remove":
			return IDLE_COUPON;
		case "edit":
			// Digitar depois de um erro limpa a mensagem; um cupom aplicado não muda ao digitar.
			return state.status === "error" ? IDLE_COUPON : state;
	}
}

function sameKey(a: CouponQuoteKey, b: CouponQuoteKey): boolean {
	return a.productCode === b.productCode && a.partners === b.partners;
}

// Cupom aplicado para outro produto ou outra quantidade de sócios: o total mostrado já não vale.
export function isCouponStale(state: CouponState, key: CouponQuoteKey): boolean {
	return state.status === "applied" && !sameKey(state.key, key);
}

// Só um cupom aplicado e atual vai no envio.
export function couponCodeForSubmit(state: CouponState, key: CouponQuoteKey): string | undefined {
	return state.status === "applied" && !isCouponStale(state, key) ? state.code : undefined;
}

// Total a mostrar: o da prévia só enquanto vale; senão o preço de tabela.
export function displayedTotalCents(state: CouponState, key: CouponQuoteKey, listCents: number): number {
	return state.status === "applied" && !isCouponStale(state, key) ? state.paidCents : listCents;
}
