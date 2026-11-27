import { describe, expect, it } from "vitest";

import { describeAdjustment } from "./wallet-adjust-logic";

describe("describeAdjustment", () => {
  it("valor positivo é crédito", () => {
    expect(describeAdjustment("10.50")).toMatch(/^Crédito de R\$\s10,50 na carteira/);
  });
  it("valor com - é débito, sem o sinal no texto", () => {
    const text = describeAdjustment("-10.50");
    expect(text).toMatch(/^Débito de R\$\s10,50 da carteira/);
    expect(text).not.toContain("-");
  });
});
