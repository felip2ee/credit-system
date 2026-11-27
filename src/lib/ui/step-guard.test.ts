import { describe, expect, it } from "vitest";

import { isStepSettled, STEP_CLICK_GUARD_MS } from "./step-guard";

describe("isStepSettled", () => {
	it("recusa o clique logo depois da troca de etapa (duplo clique)", () => {
		expect(isStepSettled(1_000, 1_000 + STEP_CLICK_GUARD_MS - 1)).toBe(false);
	});

	it("aceita depois do tempo de guarda", () => {
		expect(isStepSettled(1_000, 1_000 + STEP_CLICK_GUARD_MS)).toBe(true);
	});
});
