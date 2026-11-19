import { describe, expect, it } from "vitest";

import { buildSalePrices, formatPct, optionalPriceError, parsePctInput, partnerPriceError, pctToInput } from "./price-input";

describe("price-input", () => {
  it("accepts an empty sale price (not for sale) and rejects invalid ones", () => {
    expect(optionalPriceError("  ")).toBeNull();
    expect(optionalPriceError("400,00")).toBeNull();
    expect(optionalPriceError("0")).not.toBeNull();
    expect(optionalPriceError("abc")).not.toBeNull();
  });
  it("builds prices: empty -> null, per-partner only when allowed", () => {
    expect(buildSalePrices("", "5", false)).toEqual({ salePrice: null, salePricePerPartner: "0.00" });
    expect(buildSalePrices("1.234,50", "5,5", true)).toEqual({ salePrice: "1234.50", salePricePerPartner: "5.5" });
    expect(buildSalePrices("10", "", true).salePricePerPartner).toBe("0");
  });
  it("validates the per-partner price only when allowed", () => {
    expect(partnerPriceError("abc", false)).toBeNull();
    expect(partnerPriceError("abc", true)).not.toBeNull();
    expect(partnerPriceError("", true)).toBeNull();
  });
  it("parses pct with comma, bounds and 2 decimals", () => {
    expect(parsePctInput("20,5")).toEqual({ ok: true, value: 20.5 });
    expect(parsePctInput("0")).toEqual({ ok: true, value: 0 });
    expect(parsePctInput("99.99").ok).toBe(true);
    expect(parsePctInput("100").ok).toBe(false);
    expect(parsePctInput("1.234").ok).toBe(false);
    expect(parsePctInput("-1").ok).toBe(false);
    expect(parsePctInput("").ok).toBe(false);
    expect(parsePctInput("abc").ok).toBe(false);
  });
  it("formats pct for edit and display", () => {
    expect(pctToInput("20.00")).toBe("20");
    expect(pctToInput("12.50")).toBe("12,5");
    expect(pctToInput(null)).toBe("");
    expect(formatPct("20.00")).toBe("20%");
    expect(formatPct(null)).toBe("—");
  });
});
