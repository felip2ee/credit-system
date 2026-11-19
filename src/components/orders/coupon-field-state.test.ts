import { describe, expect, it } from "vitest";

import {
	couponCodeForSubmit,
	couponReducer,
	displayedTotalCents,
	IDLE_COUPON,
	isCouponStale,
	normalizeCouponCode,
	type CouponQuoteKey,
	type CouponState,
} from "./coupon-field-state";

const KEY: CouponQuoteKey = { productCode: "dossie_pf", partners: 0 };
const OK = { error: null, listCents: 10000, discountCents: 2500, paidCents: 7500 };
const applied = (): CouponState => {
	const applying = couponReducer(IDLE_COUPON, { type: "apply", code: "BEMVINDO", key: KEY });
	return couponReducer(applying, { type: "resolved", code: "BEMVINDO", key: KEY, result: OK });
};

describe("coupon field state", () => {
	it("normalizes to trimmed uppercase", () => {
		expect(normalizeCouponCode("  bemvindo ")).toBe("BEMVINDO");
	});

	it("stays idle when applying an empty code", () => {
		expect(couponReducer(IDLE_COUPON, { type: "apply", code: "", key: KEY })).toBe(IDLE_COUPON);
	});

	it("goes idle -> applying -> applied", () => {
		const applying = couponReducer(IDLE_COUPON, { type: "apply", code: "BEMVINDO", key: KEY });
		expect(applying.status).toBe("applying");
		expect(applied()).toMatchObject({ status: "applied", paidCents: 7500, discountCents: 2500 });
	});

	it("shows the action error exactly as returned", () => {
		const applying = couponReducer(IDLE_COUPON, { type: "apply", code: "X", key: KEY });
		const next = couponReducer(applying, { type: "resolved", code: "X", key: KEY, result: { error: "Cupom indisponível no momento" } });
		expect(next).toEqual({ status: "error", code: "X", message: "Cupom indisponível no momento" });
	});

	it("clears the error on edit", () => {
		const error: CouponState = { status: "error", code: "X", message: "m" };
		expect(couponReducer(error, { type: "edit" })).toBe(IDLE_COUPON);
	});

	it("ignores a response for a replaced request", () => {
		const applying = couponReducer(IDLE_COUPON, { type: "apply", code: "B", key: KEY });
		expect(couponReducer(applying, { type: "resolved", code: "A", key: KEY, result: OK })).toBe(applying);
		const otherKey = { ...KEY, partners: 2 };
		expect(couponReducer(applying, { type: "resolved", code: "B", key: otherKey, result: OK })).toBe(applying);
	});

	it("removes back to list price", () => {
		const state = couponReducer(applied(), { type: "remove" });
		expect(state).toBe(IDLE_COUPON);
		expect(displayedTotalCents(state, KEY, 10000)).toBe(10000);
		expect(couponCodeForSubmit(state, KEY)).toBeUndefined();
	});

	it("sends the code and the discounted total only while fresh", () => {
		const state = applied();
		expect(couponCodeForSubmit(state, KEY)).toBe("BEMVINDO");
		expect(displayedTotalCents(state, KEY, 10000)).toBe(7500);
	});

	it("is stale after product or partner change", () => {
		const state = applied();
		for (const next of [{ ...KEY, partners: 1 }, { productCode: "dossie_empresarial" as const, partners: 0 }]) {
			expect(isCouponStale(state, next)).toBe(true);
			expect(couponCodeForSubmit(state, next)).toBeUndefined();
			expect(displayedTotalCents(state, next, 20000)).toBe(20000);
		}
	});

	it("keeps zero total for a 100% coupon", () => {
		const applying = couponReducer(IDLE_COUPON, { type: "apply", code: "FREE", key: KEY });
		const state = couponReducer(applying, {
			type: "resolved",
			code: "FREE",
			key: KEY,
			result: { error: null, listCents: 10000, discountCents: 10000, paidCents: 0 },
		});
		expect(displayedTotalCents(state, KEY, 10000)).toBe(0);
		expect(couponCodeForSubmit(state, KEY)).toBe("FREE");
	});
});
