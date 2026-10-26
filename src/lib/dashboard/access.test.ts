import { describe, expect, it } from "vitest";

import { canViewRevenue } from "./access";

describe("canViewRevenue", () => {
  it("bureau_admin vê faturamento", () => {
    expect(canViewRevenue({ role: "bureau_admin", supportSessionId: null })).toBe(true);
  });
  it("operador não vê faturamento", () => {
    expect(canViewRevenue({ role: "operator", supportSessionId: null })).toBe(false);
  });
  it("sessão de suporte não vê faturamento", () => {
    expect(canViewRevenue({ role: "superadmin", supportSessionId: "s1" })).toBe(false);
    expect(canViewRevenue({ role: "bureau_admin", supportSessionId: "s1" })).toBe(false);
  });
});
