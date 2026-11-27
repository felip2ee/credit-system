import { describe, expect, it } from "vitest";

import { hashRequest } from "./queries";

describe("hashRequest", () => {
	it("does not depend on key order, and ignores undefined fields", () => {
		const a = hashRequest({ x: 1, y: { b: [1, 2], a: null }, z: undefined });
		const b = hashRequest({ y: { a: null, b: [1, 2] }, x: 1 });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when a value, an array order or a date changes", () => {
		const base = hashRequest({ amount: "10.00", at: new Date("2026-10-14T00:00:00Z"), list: [1, 2] });
		expect(hashRequest({ amount: "10.01", at: new Date("2026-10-14T00:00:00Z"), list: [1, 2] })).not.toBe(base);
		expect(hashRequest({ amount: "10.00", at: new Date("2026-10-15T00:00:00Z"), list: [1, 2] })).not.toBe(base);
		expect(hashRequest({ amount: "10.00", at: new Date("2026-10-14T00:00:00Z"), list: [2, 1] })).not.toBe(base);
	});
});
