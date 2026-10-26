import { describe, expect, it } from "vitest";

import { DASHBOARD_NAV_ITEMS, isNavActive, visibleNavItems } from "./nav-items";

const items = [
  { href: "/", label: "Dashboard" },
  { href: "/settings/counter-payments", label: "Balcão", permission: "counter:read" as const },
  { href: "/settings/payouts", label: "Repasses", permission: "payout:read" as const },
];

describe("visibleNavItems", () => {
  it("mostra item sem permissão para todos", () => {
    expect(visibleNavItems(items, []).map((i) => i.href)).toEqual(["/"]);
  });

  it("esconde o item cuja permissão falta", () => {
    expect(visibleNavItems(items, ["counter:read"]).map((i) => i.href)).toEqual(["/", "/settings/counter-payments"]);
  });

  it("mostra todos com as duas permissões", () => {
    expect(visibleNavItems(items, ["counter:read", "payout:read"])).toHaveLength(3);
  });
});

describe("DASHBOARD_NAV_ITEMS", () => {
  it("Repasses e Pagamentos de balcão vivem dentro da Carteira", () => {
    const hrefs = DASHBOARD_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).not.toContain("/settings/payouts");
    expect(hrefs).not.toContain("/settings/counter-payments");
  });
});

describe("isNavActive", () => {
  it("Carteira ativa nas sub-rotas, Configurações não", () => {
    expect(isNavActive("/settings/wallet", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/counter-payments", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/payouts", "/settings/wallet")).toBe(true);
    expect(isNavActive("/settings/counter-payments", "/settings")).toBe(false);
    expect(isNavActive("/settings/team", "/settings")).toBe(true);
  });
});
