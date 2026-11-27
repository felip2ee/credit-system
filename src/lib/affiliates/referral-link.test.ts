import { describe, expect, it } from "vitest";

import { withReferral } from "./referral-link";

describe("withReferral", () => {
	it("adds the encoded code", () => {
		expect(withReferral("/b/acme/cadastro", "ABC 1")).toBe("/b/acme/cadastro?ref=ABC%201");
	});

	it("leaves the link alone without a usable code", () => {
		for (const ref of [undefined, null, "", ["a", "b"]]) expect(withReferral("/b/acme/cadastro", ref)).toBe("/b/acme/cadastro");
	});
});
