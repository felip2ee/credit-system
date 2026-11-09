import { describe, expect, it } from "vitest";

import { hasDebt, payableOwed } from "./payable-summary";

const b = (over: Partial<Parameters<typeof payableOwed>[0]> = {}) => ({
	released: "0.00",
	retained: "0.00",
	inPayout: "0.00",
	debt: "0.00",
	...over,
});

describe("payableOwed", () => {
	it("is zero with nothing owed", () => {
		expect(payableOwed(b())).toBe("0.00");
	});

	it("adds released, retained and in-payout", () => {
		expect(payableOwed(b({ released: "40.10", retained: "30.20", inPayout: "10.30" }))).toBe("80.60");
	});

	it("subtracts the debt and can go negative", () => {
		expect(payableOwed(b({ released: "50.00", retained: "20.00", debt: "15.00" }))).toBe("55.00");
		expect(payableOwed(b({ debt: "15.00" }))).toBe("-15.00");
	});

	it("does not drift with decimals", () => {
		expect(payableOwed(b({ released: "0.10", retained: "0.20" }))).toBe("0.30");
	});
});

describe("hasDebt", () => {
	it("is true only above zero", () => {
		expect(hasDebt({ debt: "0.00" })).toBe(false);
		expect(hasDebt({ debt: "0.01" })).toBe(true);
	});
});
