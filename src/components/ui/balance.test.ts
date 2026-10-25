import { describe, expect, it } from "vitest";

import { displayBalance, HIDDEN_BALANCE } from "./balance";

describe("displayBalance", () => {
	it("mostra o valor quando não está oculto", () => {
		expect(displayBalance("R$ 1.234,56", false)).toBe("R$ 1.234,56");
	});
	it("oculto: não vaza nenhum dígito nem o tamanho do valor", () => {
		expect(displayBalance("R$ 1.234,56", true)).toBe(HIDDEN_BALANCE);
		expect(displayBalance("R$ 0,50", true)).toBe(displayBalance("R$ 99.999,99", true));
		expect(HIDDEN_BALANCE).not.toMatch(/\d/);
	});
});
