import { describe, expect, it } from "vitest";

import { computePixCharge } from "./pix-fees";

describe("computePixCharge", () => {
  it("adds the fixed fee to the recharge", () => {
    expect(computePixCharge({ feeCents: 199 }, 10_000)).toEqual({ rechargeCents: 10_000, feeCents: 199, totalCents: 10_199 });
  });

  it("zero fee keeps total equal to the recharge", () => {
    expect(computePixCharge({ feeCents: 0 }, 1000)).toEqual({ rechargeCents: 1000, feeCents: 0, totalCents: 1000 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects recharge %s", (value) => {
    expect(() => computePixCharge({ feeCents: 199 }, value)).toThrow("invalid_amount");
  });
});
