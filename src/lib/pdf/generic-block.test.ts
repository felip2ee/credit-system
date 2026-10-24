import { describe, expect, it } from "vitest";

import { columnWidths } from "./generic-block";

describe("columnWidths", () => {
  it("weights columns by the longest label or cell and sums to 1", () => {
    const widths = columnWidths(
      [{ label: "Id" }, { label: "Nome completo" }],
      [["1", "Maria Aparecida de Souza"]],
    );
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(widths[1]).toBeGreaterThan(widths[0] * 3);
  });
  it("caps a very long cell so it does not starve the others", () => {
    const widths = columnWidths([{ label: "A" }, { label: "B" }], [["x".repeat(500), "yyyyyyyyyyyyyyyyyyyy"]]);
    expect(widths[0]).toBeLessThan(0.7);
  });
});
