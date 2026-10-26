import { describe, expect, it } from "vitest";

import { mobileNavItems } from "./mobile-nav";
import { DASHBOARD_NAV_ITEMS, visibleNavItems } from "./nav-items";

describe("mobileNavItems", () => {
  it("devolve os mesmos itens da sidebar, na mesma ordem", () => {
    const perms = ["counter:read", "payout:read", "affiliates:manage"] as const;
    expect(mobileNavItems(DASHBOARD_NAV_ITEMS, perms)).toEqual(visibleNavItems(DASHBOARD_NAV_ITEMS, perms));
  });

  it("operador sem affiliates:manage não vê Afiliados", () => {
    const labels = mobileNavItems(DASHBOARD_NAV_ITEMS, ["counter:read"]).map((i) => i.label);
    expect(labels).not.toContain("Afiliados");
    expect(labels).toContain("Carteira");
  });
});
