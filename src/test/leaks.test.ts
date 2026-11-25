import { describe, expect, it } from "vitest";

import { leaks } from "@/test/leaks";

describe("leaks", () => {
	it("ignores a short value glued inside a uuid, hash, phone or timestamp", () => {
		expect(leaks('"id":"cbcaf195-987e-47c1-8247-ffa0ffadc7eb"', "987")).toBe(false);
		expect(leaks('"x":"deadbeef2099cafe"', "2099")).toBe(false);
		const row = '(6a7d669c-83ac-42ea-9100-084e8a26c912,x,phone,+5563971258912,"2026-01-01 10:00:00.712589+00",f)';
		expect(row).toContain("712589");
		expect(leaks(row, "712589")).toBe(false);
		expect(leaks("abc712589def", "712589")).toBe(false);
	});

	it("flags a short value that stands alone", () => {
		expect(leaks('{"code":"712589"}', "712589")).toBe(true);
		expect(leaks("(id,phone,+5563900000000,712589,0,5)", "712589")).toBe(true);
		expect(leaks("cvv=987,", "987")).toBe(true);
		expect(leaks("year 2099 end", "2099")).toBe(true);
	});

	it("flags a long value as a plain substring", () => {
		expect(leaks("4242424242424242", "4242424242424242")).toBe(true);
		expect(leaks("prefix-abcdefg-suffix", "abcdefg")).toBe(true);
	});
});
