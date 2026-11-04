import { describe, expect, it } from "vitest";

import { pfTopupSuggestions } from "./wallet";

describe("pfTopupSuggestions", () => {
	it("multiplica o preço PF por 1, 2, 4 e 8", () => {
		expect(pfTopupSuggestions("12.50")).toEqual([
			{ pfCount: 1, amount: "12.50" },
			{ pfCount: 2, amount: "25.00" },
			{ pfCount: 4, amount: "50.00" },
			{ pfCount: 8, amount: "100.00" },
		]);
	});

	it("sem preço PF, sem sugestão", () => {
		expect(pfTopupSuggestions(null)).toEqual([]);
	});

	it("remove valores abaixo de R$ 10,00 e acima de R$ 5.000,00", () => {
		expect(pfTopupSuggestions("3.00").map((s) => s.pfCount)).toEqual([4, 8]);
		expect(pfTopupSuggestions("1000.00").map((s) => s.pfCount)).toEqual([1, 2, 4]);
	});
});
