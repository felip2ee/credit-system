import { describe, expect, it } from "vitest";

import { formatMoney, formatSignedMoney } from "./money";

const nbsp = (s: string) => s.replace(/ /g, " ");

describe("money", () => {
  it("formata texto numérico", () => {
    expect(nbsp(formatMoney("1234.50"))).toBe("R$ 1.234,50");
  });
  it("sinal explícito", () => {
    expect(nbsp(formatSignedMoney("10.00"))).toBe("+R$ 10,00");
    expect(nbsp(formatSignedMoney("-0.10"))).toBe("−R$ 0,10");
    expect(nbsp(formatSignedMoney("0.00"))).toBe("R$ 0,00");
  });
});
