import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DASHBOARD_NAV_ITEMS } from "@/components/layout/nav-items";

// Item de menu sem ícone no mapa renderiza <undefined> e derruba o painel inteiro.
describe("sidebar", () => {
  it("tem ícone para todo item do menu", () => {
    const source = readFileSync(join(__dirname, "sidebar.tsx"), "utf8");
    const missing = DASHBOARD_NAV_ITEMS.filter((item) => !source.includes(`"${item.href}":`)).map((i) => i.href);
    expect(missing).toEqual([]);
  });
});
