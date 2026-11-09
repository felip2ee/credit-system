import { describe, expect, it } from "vitest";

import { parseStatementSource, visibleStatementSources } from "./statement-source";

describe("statement source", () => {
	it("keeps the payable filter for roles with payout:read", () => {
		expect(parseStatementSource("payable", true)).toBe("payable");
		expect(visibleStatementSources(true).map((s) => s.key)).toEqual(["all", "prepaid", "payable"]);
	});

	it("drops the payable chip and treats ?fonte=payable as all without payout:read", () => {
		expect(parseStatementSource("payable", false)).toBe("all");
		expect(visibleStatementSources(false).map((s) => s.key)).toEqual(["all", "prepaid"]);
	});

	it("falls back to all for unknown or missing values", () => {
		expect(parseStatementSource("x", true)).toBe("all");
		expect(parseStatementSource(undefined, false)).toBe("all");
		expect(parseStatementSource("prepaid", false)).toBe("prepaid");
	});
});
