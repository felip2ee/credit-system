import { describe, expect, it } from "vitest";

import { advance, canContinue, errorsForStep, firstStepWithErrors, previousStep, stepsFor, submitAction } from "./checkout-steps";

describe("stepsFor", () => {
	it("skips the method step when card is not enabled", () => {
		expect(stepsFor(false, "PIX")).toEqual(["amount", "payer"]);
		expect(stepsFor(false, "CREDIT_CARD")).toEqual(["amount", "payer"]);
	});
	it("ends at payer for Pix when card is enabled", () => {
		expect(stepsFor(true, "PIX")).toEqual(["amount", "method", "payer"]);
	});
	it("adds the card step for card", () => {
		expect(stepsFor(true, "CREDIT_CARD")).toEqual(["amount", "method", "payer", "card"]);
	});
});

describe("canContinue", () => {
	it("blocks only on errors of the step", () => {
		const errors = { amount: "x", number: "y" };
		expect(canContinue("amount", errors)).toBe(false);
		expect(canContinue("payer", errors)).toBe(true);
		expect(canContinue("card", errors)).toBe(false);
		expect(canContinue("method", errors)).toBe(true);
	});
	it("filters errors by step", () => {
		expect(errorsForStep("payer", { name: "a", declaration: "b", cvv: "c" })).toEqual({ name: "a", declaration: "b" });
	});
	it("finds the first step with errors", () => {
		const steps = stepsFor(true, "CREDIT_CARD");
		expect(firstStepWithErrors(steps, { cvv: "c", email: "e" })).toBe("payer");
		expect(firstStepWithErrors(steps, {})).toBeNull();
	});
});

describe("fluxo", () => {
	const steps = stepsFor(true, "CREDIT_CARD");
	it("avança só com a etapa atual sem erro", () => {
		expect(advance(steps, "amount", { number: "y" }).step).toBe("method");
		expect(advance(steps, "amount", { amount: "x" })).toEqual({ errors: { amount: "x" }, step: "amount" });
	});
	it("envio rejeitado volta à primeira etapa com erro", () => {
		expect(firstStepWithErrors(steps, { cvv: "c", email: "e" })).toBe("payer");
	});
	it("voltar só muda a etapa", () => {
		expect(previousStep(steps, "payer")).toBe("method");
		expect(previousStep(steps, "amount")).toBe("amount");
	});
	it("Enter avança fora da última etapa", () => {
		expect(submitAction(steps, "payer")).toBe("next");
		expect(submitAction(steps, "card")).toBe("submit");
	});
});
