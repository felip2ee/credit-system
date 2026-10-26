import { describe, expect, it } from "vitest";

import { failureMessage } from "./failure-message";

describe("failureMessage", () => {
	it("tells what happened, what happened to the money and what to do", () => {
		expect(
			failureMessage({ what: "Não conseguimos consultar este CPF agora.", money: "refunded", next: "Tente de novo mais tarde." }),
		).toEqual({
			title: "Não conseguimos consultar este CPF agora.",
			money: "O valor voltou para o seu saldo.",
			next: "Tente de novo mais tarde.",
		});
	});

	it.each([
		["not_charged", "Nada foi cobrado."],
		["reserved", "O valor continua reservado."],
		["none", null],
	] as const)("maps money %s", (money, text) => {
		expect(failureMessage({ what: "x", money, next: "y" }).money).toBe(text);
	});
});
