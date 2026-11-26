import { describe, expect, it } from "vitest";

import { orderStepsFor, orderStepTitle, stepWithErrors } from "./order-wizard-steps";

describe("orderStepsFor", () => {
	it("própria de conta PF ou sem Titular tem 2 etapas: choice e review", () => {
		expect(orderStepsFor("dossie_pf", "PF")).toEqual(["choice", "review"]);
		expect(orderStepsFor("dossie_pf", null)).toEqual(["choice", "review"]);
	});

	it("dossie_pf de conta PJ pede o responsável: choice, subject, review", () => {
		expect(orderStepsFor("dossie_pf", "PJ")).toEqual(["choice", "subject", "review"]);
	});

	it("empresarial tem 4 etapas em qualquer conta", () => {
		const all = ["choice", "subject", "people", "review"];
		for (const holder of ["PF", "PJ", null] as const) expect(orderStepsFor("dossie_empresarial", holder)).toEqual(all);
	});
});

describe("orderStepTitle", () => {
	it("título de subject muda entre empresa e responsável", () => {
		expect(orderStepTitle("subject", "dossie_empresarial")).toBe("Dados da empresa");
		expect(orderStepTitle("subject", "dossie_pf")).toBe("Dados do responsável");
	});

	it("títulos fixos das outras etapas", () => {
		expect(orderStepTitle("choice", "dossie_pf")).toBe("Para quem é a pesquisa?");
		expect(orderStepTitle("people", "dossie_empresarial")).toBe("Pessoas da empresa");
		expect(orderStepTitle("review", "dossie_pf")).toBe("Revise o pedido");
	});
});

describe("stepWithErrors", () => {
	it("devolve a primeira etapa com erro, ignora campo fora do caminho e devolve null sem erro", () => {
		expect(stepWithErrors(["choice", "review"], ["partners"])).toBeNull();
		expect(stepWithErrors(["choice", "subject", "people", "review"], ["partners", "subject"])).toBe("subject");
		expect(stepWithErrors(["choice", "subject", "people", "review"], [])).toBeNull();
	});
});
