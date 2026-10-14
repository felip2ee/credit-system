import { describe, expect, it } from "vitest";

import { visibleNavItems } from "./nav-items";

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
