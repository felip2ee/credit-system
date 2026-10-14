import { describe, expect, it } from "vitest";

import { moneyError, normalizeMoney } from "./money";

describe("moneyError", () => {
  it("rejects invalid money", () => {
    expect(moneyError("abc")).toMatch(/valor/i);
    expect(moneyError("0")).not.toBeNull();
    expect(moneyError("1.234")).not.toBeNull();
    expect(moneyError("100000000")).not.toBeNull();
  });
  it("accepts comma decimals", () => {
    expect(moneyError("12,50")).toBeNull();
    expect(normalizeMoney(" 12,50 ")).toBe("12.50");
  });
});
