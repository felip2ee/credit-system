import { describe, expect, it } from "vitest";

import { amountStepError, keyStepErrors } from "./withdrawal-steps";

const fee = { fixed: "3.00", percent: "1.00" };

describe("amountStepError", () => {
	it("pede o valor quando vazio", () => {
		expect(amountStepError("  ", fee)).toBe("Informe o valor do saque.");
	});
	it("recusa valor que a taxa consome", () => {
		expect(amountStepError("3.00", fee)).toBe("Informe um valor maior que a taxa de saque.");
		expect(amountStepError("abc", fee)).toBe("Informe um valor maior que a taxa de saque.");
	});
	it("aceita valor maior que a taxa", () => {
		expect(amountStepError("50.00", fee)).toBeNull();
	});
});

describe("keyStepErrors", () => {
	it("exige chave e declaração", () => {
		expect(keyStepErrors("", false)).toEqual({ pixKey: "Informe a chave PIX.", ownKey: "Confirme que a chave PIX está no seu nome." });
	});
	it("passa com os dois", () => {
		expect(keyStepErrors("a@b.com", true)).toEqual({});
	});
});
