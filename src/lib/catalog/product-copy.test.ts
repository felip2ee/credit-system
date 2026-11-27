import { describe, expect, it } from "vitest";

import { productCopy, productRules } from "./product-copy";

describe("productCopy", () => {
	it.each(["dossie_pf", "dossie_empresarial"])("retorna texto para %s", (code) => {
		const copy = productCopy(code);
		expect(copy?.summary).toBeTruthy();
		expect(copy?.includes.length).toBeGreaterThan(0);
	});

	it("PF para outra pessoa (conta PJ) não fala em seu CPF", () => {
		const copy = productCopy("dossie_pf", false);
		expect([copy?.summary, ...(copy?.includes ?? [])].join(" ")).not.toMatch(/\bseu\b|\bvocê\b/i);
		expect(productCopy("dossie_pf", true)?.summary).toContain("seu CPF");
	});

	it("PF em conta PJ: pesquisa o CPF informado, com a autorização da pessoa", () => {
		expect(productRules("dossie_pf", false)).toEqual([
			"A pesquisa é do CPF que você informar, como o do responsável pela empresa.",
			"A consulta só roda depois da autorização da pessoa pesquisada.",
		]);
	});

	it("retorna null para código desconhecido", () => {
		expect(productCopy("x")).toBeNull();
	});
});
