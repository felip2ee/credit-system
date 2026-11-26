import { describe, expect, it } from "vitest";

import { orderTotalCents } from "@/components/orders/order-rules";

import { isTopupAmountCents, referencePriceRows } from "./reference-prices";

const pf = { salePrice: "197.00" };
const pj = { salePrice: "297.00", salePricePerPartner: "100.00" };

describe("referencePriceRows", () => {
	it("lists PF and PJ + 1 to 8 partners in integer cents", () => {
		expect(referencePriceRows(pf, pj, 20).map((r) => [r.key, r.cents])).toEqual([
			["pf", 19700],
			["pj-1", 39700],
			["pj-2", 49700],
			["pj-3", 59700],
			["pj-4", 69700],
			["pj-5", 79700],
			["pj-6", 89700],
			["pj-7", 99700],
			["pj-8", 109700],
		]);
	});
	it("matches the order form quote", () => {
		const prices = { code: "dossie_empresarial" as const, price: "297.10", pricePerPartner: "99.99" };
		const rows = referencePriceRows(null, { salePrice: prices.price, salePricePerPartner: prices.pricePerPartner }, 20);
		rows.forEach((r, i) => expect(r.cents).toBe(orderTotalCents(prices, i + 1)));
	});
	it("omits a product that is not for sale", () => {
		expect(referencePriceRows(null, pj, 20).map((r) => r.key)).toEqual(["pj-1", "pj-2", "pj-3", "pj-4", "pj-5", "pj-6", "pj-7", "pj-8"]);
		expect(referencePriceRows(pf, null, 20).map((r) => r.key)).toEqual(["pf"]);
		expect(referencePriceRows(undefined, undefined, 20)).toEqual([]);
	});
	it("keeps the base price when the partner price is zero", () => {
		const rows = referencePriceRows(null, { salePrice: "297.00", salePricePerPartner: "0.00" }, 20);
		expect(rows.map((r) => r.cents)).toEqual(Array(8).fill(29700));
	});
	it("respects the partner limit", () => {
		expect(referencePriceRows(null, pj, 2).map((r) => r.key)).toEqual(["pj-1", "pj-2"]);
		expect(referencePriceRows(null, pj, 0)).toEqual([]);
	});
});

describe("isTopupAmountCents", () => {
	it("accepts R$ 10,00 to R$ 5.000,00", () => {
		expect([999, 1000, 500000, 500001].map(isTopupAmountCents)).toEqual([false, true, true, false]);
	});
});
