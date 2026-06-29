import { describe, expect, it } from "vitest";

import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ, depsProductName } from "./products";

describe("depsProductName", () => {
  it("mapeia o tipo para o nome do produto correto", () => {
    expect(depsProductName("PF")).toBe(DEPS_PRODUCT_PF);
    expect(depsProductName("PJ")).toBe(DEPS_PRODUCT_PJ);
  });

  it("PF e PJ não se confundem", () => {
    expect(DEPS_PRODUCT_PF).not.toBe(DEPS_PRODUCT_PJ);
  });
});
