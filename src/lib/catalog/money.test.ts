import { describe, expect, it } from "vitest";

import { fromCents, isPriceSellable, toCents } from "./money";

describe("toCents", () => {
  it("0.10 + 0.20 equals 0.30 in cents", () => {
    expect(toCents("0.10") + toCents("0.20")).toBe(toCents("0.30"));
    expect(fromCents(toCents("0.10") + toCents("0.20"))).toBe("0.30");
  });

  it("reads one decimal place, none and the upper bound", () => {
    expect(toCents("12.5")).toBe(1250);
    expect(toCents("7")).toBe(700);
    expect(toCents("99999999.99")).toBe(9_999_999_999);
  });

  it.each(["", "abc", "-1.00", "1,50", "1.234", "100000000.00", "1e3", " 1.00", "1."])(
    "rejects %j",
    (value) => {
      expect(() => toCents(value)).toThrow(RangeError);
    },
  );
});

describe("fromCents", () => {
  it("formats with two decimals and rejects invalid cents", () => {
    expect(fromCents(5)).toBe("0.05");
    expect(fromCents(123456)).toBe("1234.56");
    expect(() => fromCents(1.5)).toThrow(RangeError);
    expect(() => fromCents(-1)).toThrow(RangeError);
    expect(() => fromCents(10_000_000_000)).toThrow(RangeError);
  });
});

describe("isPriceSellable", () => {
  it("needs a price at or above the cost, and accepts a cost of zero", () => {
    expect(isPriceSellable(1000, 1000)).toBe(true);
    expect(isPriceSellable(999, 1000)).toBe(false);
    expect(isPriceSellable(500, 0)).toBe(true);
  });
});
