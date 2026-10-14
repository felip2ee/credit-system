import { describe, expect, it } from "vitest";

import { moneyError, normalizeMoney } from "./money-input";

describe("moneyError", () => {
  it("rejects invalid money", () => {
    expect(moneyError("abc")).toMatch(/valor/i);
    expect(moneyError("0")).not.toBeNull();
    expect(moneyError("1.234")).not.toBeNull();
    expect(moneyError("100000000")).not.toBeNull();
  });
  it("rejects the ambiguous 1.234.50", () => {
    expect(moneyError("1.234.50")).not.toBeNull();
  });
  it("accepts comma decimals and pt-BR thousands", () => {
    expect(moneyError("12,50")).toBeNull();
    expect(moneyError("1.234,50")).toBeNull();
  });
});

describe("normalizeMoney", () => {
  it.each([
    [" 12,50 ", "12.50"],
    ["12.50", "12.50"],
    ["1.234,50", "1234.50"],
    ["1.234.567,89", "1234567.89"],
    ["1.234.50", "1.234.50"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeMoney(input)).toBe(expected);
  });
});
