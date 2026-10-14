import { afterEach, describe, expect, it, vi } from "vitest";

import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ, depsProductName } from "./products";

afterEach(() => vi.unstubAllEnvs());

describe("depsProductName", () => {
  it("sem env, usa as constantes e PF e PJ não se confundem", () => {
    vi.stubEnv("DEPS_PRODUTO_PF", "");
    vi.stubEnv("DEPS_PRODUTO_PJ", "");
    expect(depsProductName("PF")).toBe(DEPS_PRODUCT_PF);
    expect(depsProductName("PJ")).toBe(DEPS_PRODUCT_PJ);
    expect(DEPS_PRODUCT_PF).not.toBe(DEPS_PRODUCT_PJ);
  });

  it("env sobrescreve o nome do produto do tipo", () => {
    vi.stubEnv("DEPS_PRODUTO_PF", "Smart PF 999");
    vi.stubEnv("DEPS_PRODUTO_PJ", "");
    expect(depsProductName("PF")).toBe("Smart PF 999");
    expect(depsProductName("PJ")).toBe(DEPS_PRODUCT_PJ);
  });
});
