import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  limitLabel,
  setAllProducts,
  setMaxUses,
  setMaxUsesPerClient,
  toggleProduct,
  validateDraft,
  type CouponDraft,
} from "@/components/settings/coupons/coupon-form-logic";

const valid: CouponDraft = { ...EMPTY_DRAFT, code: " bem-vindo10 ", value: "10" };

describe("validateDraft", () => {
  it("accepts a valid draft; empty limits mean unlimited (null); code is normalized", () => {
    const r = validateDraft(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values.code).toBe("BEM-VINDO10");
      expect(r.values.maxUses).toBeNull();
      expect(r.values.maxUsesPerClient).toBeNull();
      expect(r.values.validFrom).toBeNull();
      expect(r.values.validUntil).toBeNull();
    }
  });

  it("rejects a 5-character code and accepts 6", () => {
    expect(validateDraft({ ...valid, code: "abcde" }).ok).toBe(false);
    expect(validateDraft({ ...valid, code: "abcdef" }).ok).toBe(true);
  });

  it("accepts pt-BR decimal comma and thousands in a fixed value", () => {
    const r = validateDraft({ ...valid, kind: "fixed", value: "1.234,50" });
    expect(r.ok && r.values.value).toBe("1234.50");
  });

  it("reports field errors in pt-BR", () => {
    const r = validateDraft({ ...valid, code: "a", maxUses: "0", maxUsesPerClient: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.code).toContain("6 a 32");
      expect(r.errors.maxUses).toBe("O limite deve ser maior que zero.");
      expect(r.errors.maxUsesPerClient).toBe("Informe um número inteiro.");
    }
    // Regras cruzadas (valor, produtos, período) só rodam quando os campos simples são válidos.
    const v = validateDraft({ ...valid, value: "150" });
    expect(!v.ok && v.errors.value).toContain("entre 0,01 e 100");
  });

  it("requires a product when not all products; end date must be after start", () => {
    const r = validateDraft({
      ...valid,
      allProducts: false,
      validFrom: "2026-12-10",
      validUntil: "2026-12-01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.productCodes).toBe("Escolha ao menos um produto.");
      expect(r.errors.validUntil).toBe("A validade deve ser depois do início.");
    }
  });

  it("same-day start and end is valid (end of day)", () => {
    expect(validateDraft({ ...valid, validFrom: "2026-12-01", validUntil: "2026-12-01" }).ok).toBe(true);
  });
});

describe("per-client limit default", () => {
  it("pre-fills 1 when a total limit is set and the per-client field is untouched", () => {
    const d = setMaxUses(valid, "10");
    expect(d.maxUsesPerClient).toBe("1");
    const r = validateDraft(d);
    expect(r.ok && [r.values.maxUses, r.values.maxUsesPerClient]).toEqual([10, 1]);
  });

  it("clearing the total limit clears the untouched suggestion", () => {
    expect(setMaxUses(setMaxUses(valid, "10"), "").maxUsesPerClient).toBe("");
  });

  it("explicit empty per-client stays unlimited (null) after the user touched it", () => {
    const d = setMaxUses(setMaxUsesPerClient(setMaxUses(valid, "10"), ""), "20");
    expect(d.maxUsesPerClient).toBe("");
    const r = validateDraft(d);
    expect(r.ok && [r.values.maxUses, r.values.maxUsesPerClient]).toEqual([20, null]);
  });

  it("keeps a number the user typed", () => {
    const d = setMaxUses(setMaxUsesPerClient(valid, "3"), "10");
    expect(d.maxUsesPerClient).toBe("3");
  });
});

describe("product scope", () => {
  it("toggles chosen products", () => {
    let d = setAllProducts(valid, false);
    d = toggleProduct(d, "dossie_pf");
    d = toggleProduct(d, "dossie_empresarial");
    expect(d.productCodes).toEqual(["dossie_pf", "dossie_empresarial"]);
    expect(toggleProduct(d, "dossie_pf").productCodes).toEqual(["dossie_empresarial"]);
  });

  it("switching to all products clears the choice and sends no product codes", () => {
    const chosen = toggleProduct(setAllProducts(valid, false), "dossie_pf");
    const all = setAllProducts(chosen, true);
    expect(all.productCodes).toEqual([]);
    const r = validateDraft(all);
    expect(r.ok && r.values.productCodes).toEqual([]);
  });
});

describe("limitLabel", () => {
  it("shows Ilimitado for null", () => {
    expect(limitLabel(null)).toBe("Ilimitado");
    expect(limitLabel(5)).toBe("5");
  });
});
