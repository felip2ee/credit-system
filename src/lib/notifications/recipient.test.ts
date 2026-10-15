import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ config: {} }));

import { brazilianVariants, maskRecipient, normalizeEmail, toE164 } from "./recipient";

describe("toE164", () => {
	it.each(["(63) 9 9234-5615", "63992345615", "5563992345615", "+55 63 99234-5615", " 63.99234.5615 "])(
		"normalizes %s to a Brazilian mobile number",
		(input) => {
			expect(toE164(input)).toBe("+5563992345615");
		},
	);

	it("normalizes a Brazilian landline", () => {
		expect(toE164("6332345615")).toBe("+556332345615");
		expect(toE164("556332345615")).toBe("+556332345615");
	});

	it("keeps a foreign number that starts with +", () => {
		expect(toE164("+14155550123")).toBe("+14155550123");
	});

	it.each([
		"0636399234561", // operadora (0) na frente
		"639923456", // 9 dígitos
		"+0123", // + com 0 na frente e curto
		"+1234567", // + com menos de 8 dígitos
		"+1234567890123456", // + com mais de 15 dígitos
		"00992345615", // DDD 00
		"10992345615", // DDD 10
		"6382345615", // 10 dígitos de celular antigo, sem o 9
		"63892345615", // 11 dígitos sem 9 na frente
		"5563892345615",
		"abc",
		"",
	])("rejects %s", (input) => {
		expect(toE164(input)).toBeNull();
	});
});

describe("brazilianVariants", () => {
	it("returns the forms with and without the ninth digit for a mobile number", () => {
		expect(brazilianVariants("+5563992345615")).toEqual(["+5563992345615", "+556392345615"]);
	});

	it("returns the form with the ninth digit for an old mobile number", () => {
		expect(brazilianVariants("+556392345615")).toEqual(["+556392345615", "+5563992345615"]);
	});

	it("returns one form for a landline and for a foreign number", () => {
		expect(brazilianVariants("+556332345615")).toEqual(["+556332345615"]);
		expect(brazilianVariants("+14155550123")).toEqual(["+14155550123"]);
	});
});

describe("normalizeEmail", () => {
	it("trims and lowercases", () => {
		expect(normalizeEmail("  Maria@Exemplo.COM ")).toBe("maria@exemplo.com");
	});

	it("rejects an invalid address", () => {
		expect(normalizeEmail("sem-arroba")).toBeNull();
		expect(normalizeEmail("a b@c.com")).toBeNull();
	});
});

describe("maskRecipient", () => {
	it("masks a Brazilian phone number keeping the country code and the last 4 digits", () => {
		expect(maskRecipient("whatsapp", "+5563992345615")).toBe("+55*******5615");
	});

	it("masks a foreign phone number keeping only the last 4 digits", () => {
		expect(maskRecipient("whatsapp", "+14155550123")).toBe("+*******0123");
	});

	it("masks an e-mail with the shared auth mask", () => {
		expect(maskRecipient("email", "maria@exemplo.com")).toBe("m***@exemplo.com");
	});
});
