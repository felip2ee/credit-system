import { describe, expect, it } from "vitest";

import { canActOnWithdrawal } from "./withdrawal-queue-rules";

describe("canActOnWithdrawal", () => {
  it("permite agir só no saque aberto", () => {
    expect(canActOnWithdrawal("open")).toBe(true);
  });

  it.each(["paid", "cancelled"] as const)("bloqueia o saque %s", (status) => {
    expect(canActOnWithdrawal(status)).toBe(false);
  });
});
