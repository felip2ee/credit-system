import { describe, expect, it } from "vitest";

import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "./products";

describe("DEPS_PRODUCT_*", () => {
  it("PF e PJ não se confundem", () => {
    expect(DEPS_PRODUCT_PF).not.toBe(DEPS_PRODUCT_PJ);
  });
});
