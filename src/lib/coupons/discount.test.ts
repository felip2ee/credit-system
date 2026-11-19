import { describe, expect, it } from "vitest";

import { computeCouponDiscount, eligibleTotalCents } from "./discount";

describe("computeCouponDiscount", () => {
	it("percent rounds once, half a cent goes up", () => {
		// 3333 * 33.33% = 1110.8889 -> 1111
		expect(computeCouponDiscount({ kind: "percent", value: 33.33, eligibleTotalCents: 3333 })).toEqual({
			discountCents: 1111,
			paidCents: 2222,
		});
		// 5 * 10% = 0.5 -> 1 (round half up, como o round do numeric)
		expect(computeCouponDiscount({ kind: "percent", value: 10, eligibleTotalCents: 5 })).toEqual({ discountCents: 1, paidCents: 4 });
		// 4 * 12.5% = 0.5 -> 1
		expect(computeCouponDiscount({ kind: "percent", value: 12.5, eligibleTotalCents: 4 }).discountCents).toBe(1);
		// abaixo de meio centavo: 0
		expect(computeCouponDiscount({ kind: "percent", value: 0.01, eligibleTotalCents: 4999 }).discountCents).toBe(0);
	});

	it("100% pays zero", () => {
		expect(computeCouponDiscount({ kind: "percent", value: 100, eligibleTotalCents: 5000 })).toEqual({
			discountCents: 5000,
			paidCents: 0,
		});
	});

	it("fixed value in reais, capped at the base: paid never negative", () => {
		expect(computeCouponDiscount({ kind: "fixed", value: 12.5, eligibleTotalCents: 5000 })).toEqual({
			discountCents: 1250,
			paidCents: 3750,
		});
		expect(computeCouponDiscount({ kind: "fixed", value: 80, eligibleTotalCents: 5000 })).toEqual({
			discountCents: 5000,
			paidCents: 0,
		});
	});

	it("base 0 gives no discount", () => {
		expect(computeCouponDiscount({ kind: "percent", value: 50, eligibleTotalCents: 0 })).toEqual({ discountCents: 0, paidCents: 0 });
		expect(computeCouponDiscount({ kind: "fixed", value: 10, eligibleTotalCents: 0 })).toEqual({ discountCents: 0, paidCents: 0 });
	});

	it("handles the largest price without losing precision", () => {
		const base = 9_999_999_999; // 99999999.99
		const { discountCents, paidCents } = computeCouponDiscount({ kind: "percent", value: 99.99, eligibleTotalCents: base });
		expect(discountCents + paidCents).toBe(base);
		expect(Number.isInteger(discountCents)).toBe(true);
	});
});

describe("eligibleTotalCents", () => {
	const lines = [
		{ code: "dossie_empresarial", priceCents: 8000 },
		{ code: "dossie_empresarial", priceCents: 6000 },
		{ code: "dossie_pf", priceCents: 5000 },
	];

	it("sums only the lines of accepted products", () => {
		expect(eligibleTotalCents(lines, ["dossie_empresarial"])).toBe(14000);
		expect(eligibleTotalCents(lines, [])).toBe(0);
	});
});
