import { describe, expect, it } from "vitest";

import { convertAmountError } from "./convert-rules";

describe("convertAmountError", () => {
	it.each(["4", "4.5", "4.00"])("aceita %s", (amount) => {
		expect(convertAmountError(amount)).toBeNull();
	});
	it.each(["", "0", "0.00", "-1", "4,00", "4.001", "abc", "100000000"])("recusa %j antes de pedir a confirmação", (amount) => {
		expect(convertAmountError(amount)).toBe("Informe um valor maior que zero, com até 2 casas decimais.");
	});
});
