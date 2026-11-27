import { describe, expect, it } from "vitest";

import { hasTypedProductData, identityErrors, PARTNER_CODE, valuesErrors } from "./product-wizard-steps";

const values = { baseCost: "3,50", baseCostPerPartner: "", salePrice: "", salePricePerPartner: "", hasPartner: false };

describe("identityErrors", () => {
  it("accepts a valid code and name (DEPS name is optional)", () => {
    expect(identityErrors({ code: "dossie_pf", name: "Dossiê PF", depsProduct: "" })).toEqual({});
  });
  it("rejects a code with uppercase, spaces or fewer than 3 characters", () => {
    expect(identityErrors({ code: "Ab", name: "x", depsProduct: "" }).code).toBeDefined();
    expect(identityErrors({ code: "dossie pf", name: "x", depsProduct: "" }).code).toBeDefined();
  });
  it("rejects an empty name", () => {
    expect(identityErrors({ code: "dossie_pf", name: "  ", depsProduct: "" }).name).toBeDefined();
  });
  it("rejects a DEPS name over 120 characters", () => {
    expect(identityErrors({ code: "dossie_pf", name: "x", depsProduct: "a".repeat(121) }).depsProduct).toBeDefined();
  });
});

describe("valuesErrors", () => {
  it("accepts a cost with no price (product not for sale)", () => {
    expect(valuesErrors(values)).toEqual({});
  });
  it("rejects an invalid cost and an invalid price", () => {
    expect(valuesErrors({ ...values, baseCost: "abc" }).baseCost).toBeDefined();
    expect(valuesErrors({ ...values, salePrice: "-1" }).salePrice).toBeDefined();
  });
  it("ignores partner fields when the product has no partners", () => {
    expect(valuesErrors({ ...values, baseCostPerPartner: "abc", salePricePerPartner: "abc" })).toEqual({});
  });
  it("validates partner fields for the company dossier; empty price per partner counts as 0", () => {
    const partner = { ...values, hasPartner: true };
    expect(valuesErrors(partner)).toEqual({ baseCostPerPartner: expect.any(String) });
    expect(valuesErrors({ ...partner, baseCostPerPartner: "4", salePricePerPartner: "" })).toEqual({});
    expect(valuesErrors({ ...partner, baseCostPerPartner: "4", salePricePerPartner: "x" }).salePricePerPartner).toBeDefined();
  });
  it("exposes the company dossier code", () => {
    expect(PARTNER_CODE).toBe("dossie_empresarial");
  });
});

describe("hasTypedProductData", () => {
  const empty = { code: "", name: "", depsProduct: "", baseCost: "", baseCostPerPartner: "", salePrice: "", salePricePerPartner: "" };
  it("is false for a blank form and true as soon as any field has text", () => {
    expect(hasTypedProductData(empty)).toBe(false);
    expect(hasTypedProductData({ ...empty, name: " " })).toBe(false);
    expect(hasTypedProductData({ ...empty, salePrice: "10" })).toBe(true);
  });
});
