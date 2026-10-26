import { describe, expect, it } from "vitest";

import { derivePaymentState, parsePaymentFilter } from "./overview";

const base = { orderState: "ready", settlementStatus: null, price: "100.00", paidTotal: "0.00" } as const;

describe("parsePaymentFilter", () => {
	it("accepts the allowlist and falls back to all", () => {
		expect(parsePaymentFilter("client")).toBe("client");
		expect(parsePaymentFilter("counter")).toBe("counter");
		expect(parsePaymentFilter("x'; drop")).toBe("all");
		expect(parsePaymentFilter(undefined)).toBe("all");
	});
});

describe("derivePaymentState", () => {
	it("online with reserved or captured balance is paid", () => {
		expect(derivePaymentState({ ...base, mode: "online", settlementStatus: "reserved" })).toBe("paid");
		expect(derivePaymentState({ ...base, mode: "online", settlementStatus: "captured" })).toBe("paid");
	});
	it("online without settlement waits", () => {
		expect(derivePaymentState({ ...base, mode: "online" })).toBe("awaiting");
	});
	it("online released is refunded", () => {
		expect(derivePaymentState({ ...base, mode: "online", settlementStatus: "released" })).toBe("refunded");
	});
	it("counter is paid only when the total covers the price", () => {
		expect(derivePaymentState({ ...base, mode: "counter", settlementStatus: "reserved", paidTotal: "99.99" })).toBe("awaiting");
		expect(derivePaymentState({ ...base, mode: "counter", settlementStatus: "reserved", paidTotal: "100.00" })).toBe("paid");
		expect(derivePaymentState({ ...base, mode: "counter", price: null })).toBe("awaiting");
	});
	it("cancelled order wins over payment totals", () => {
		expect(derivePaymentState({ ...base, mode: "counter", orderState: "cancelled", paidTotal: "100.00" })).toBe("cancelled");
		expect(derivePaymentState({ ...base, mode: "counter", settlementStatus: "released" })).toBe("cancelled");
	});
});
