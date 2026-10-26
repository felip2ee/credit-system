import { describe, expect, it } from "vitest";

import { productCopy } from "./product-copy";

describe("productCopy", () => {
	it.each(["dossie_pf", "dossie_empresarial"])("retorna texto para %s", (code) => {
		const copy = productCopy(code);
		expect(copy?.summary).toBeTruthy();
		expect(copy?.includes.length).toBeGreaterThan(0);
	});

	it("retorna null para código desconhecido", () => {
		expect(productCopy("x")).toBeNull();
	});
});
