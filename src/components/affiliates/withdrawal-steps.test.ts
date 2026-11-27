import { describe, expect, it } from "vitest";

import { amountStepError, isAmountFailure, keyStepErrors } from "./withdrawal-steps";

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

describe("isAmountFailure", () => {
	it("reconhece as recusas por valor", () => {
		expect(isAmountFailure("Valor maior que o saldo disponível. O valor em carência ainda não pode ser usado.")).toBe(true);
		expect(isAmountFailure("O valor é menor ou igual à taxa de saque. Peça um valor maior.")).toBe(true);
		expect(isAmountFailure("Informe um valor maior que zero, com até 2 casas decimais.")).toBe(true);
	});
	it("deixa as outras na etapa da chave", () => {
		expect(isAmountFailure("Chave PIX inválida.")).toBe(false);
		expect(isAmountFailure("Você já tem um saque em aberto. Espere o pagamento ou o cancelamento.")).toBe(false);
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
