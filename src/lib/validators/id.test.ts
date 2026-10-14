import { describe, expect, it } from "vitest";

import { isUuid } from "./id";

describe("isUuid", () => {
	it("accepts a uuid", () => {
		expect(isUuid("6f1c2c1e-0b6e-4b8e-9a53-3a0e2f6f4d11")).toBe(true);
	});

	it.each(["abc", "", "6f1c2c1e", "6f1c2c1e-0b6e-4b8e-9a53-3a0e2f6f4d1z", null, 42])(
		"rejects %j",
		(value) => {
			expect(isUuid(value)).toBe(false);
		},
	);
});
