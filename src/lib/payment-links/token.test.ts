import { describe, expect, it } from "vitest";

import { generateToken, hashToken, PAYMENT_LINK_TOKEN_PATTERN } from "./token";

describe("generateToken", () => {
	it("returns a 32-byte url-safe token and the SHA-256 hex of it", () => {
		const { token, hash } = generateToken();
		expect(token).toMatch(PAYMENT_LINK_TOKEN_PATTERN);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(hashToken(token));
		expect(hash).not.toContain(token);
	});

	it("never repeats", () => {
		expect(generateToken().token).not.toBe(generateToken().token);
	});
});
