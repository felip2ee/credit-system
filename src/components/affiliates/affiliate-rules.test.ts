import { describe, expect, it } from "vitest";

import { commissionStatusLabel, withdrawalPreview } from "./affiliate-rules";

describe("withdrawalPreview", () => {
	it("calcula taxa fixa mais percentual e o líquido", () => {
		expect(withdrawalPreview("100.00", { fixed: "2.00", percent: "1" })).toEqual({ fee: "3.00", net: "97.00", valid: true });
	});

	it("arredonda a taxa para centavos", () => {
		expect(withdrawalPreview("10.00", { fixed: "0", percent: "1.5" })).toEqual({ fee: "0.15", net: "9.85", valid: true });
	});

	it("é inválido quando o valor não passa da taxa", () => {
		expect(withdrawalPreview("2.00", { fixed: "2.00", percent: "0" }).valid).toBe(false);
	});

	it("é inválido para valor vazio, zero ou mal formado", () => {
		for (const amount of ["", "0", "abc", "1,5"]) {
			expect(withdrawalPreview(amount, { fixed: "2.00", percent: "1" }).valid).toBe(false);
		}
	});
});

describe("commissionStatusLabel", () => {
	it("mostra a data de liberação na carência", () => {
		expect(commissionStatusLabel("pending", "2026-11-05T12:00:00.000Z")).toBe("Em carência até 05/11");
	});

	it("rotula disponível e revertida", () => {
		expect(commissionStatusLabel("released", "2026-11-05T12:00:00.000Z")).toBe("Disponível");
		expect(commissionStatusLabel("reversed", "2026-11-05T12:00:00.000Z")).toBe("Revertida");
	});
});
