import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ upsertCatalogItem: vi.fn() }));

import { CatalogForm } from "@/components/settings/catalog-form";
import type { CatalogEntry } from "@/lib/catalog/queries";

const entry: CatalogEntry = {
  productId: "p1",
  productVersionId: "v1",
  code: "consulta_pf",
  name: "Consulta PF",
  kind: "main",
  addonFor: null,
  effectiveCost: "10.00",
  item: { active: true, salePrice: "5.00" },
  sellable: false,
  onSale: false,
};

const render = (canWrite: boolean, entries: CatalogEntry[] = [entry]) =>
  renderToStaticMarkup(createElement(CatalogForm, { entries, canWrite }));

describe("CatalogForm", () => {
  it("shows warning when price is below cost", () => {
    expect(render(true)).toContain("Preço abaixo do custo");
  });

  it("disables controls without catalog:write", () => {
    const html = render(false);
    expect(html).not.toContain("Salvar");
    expect(html.match(/disabled=""/g)?.length).toBe(2); // price input + switch
  });

  it("shows 'Custo não definido' when the cost is 0.00", () => {
    const html = render(true, [{ ...entry, effectiveCost: "0.00" }]);
    expect(html).toContain("Custo não definido");
    expect(html).not.toContain("Preço abaixo do custo");
  });

  it("locks only the off-to-on switch of a blocked addon", () => {
    const addon: CatalogEntry = {
      ...entry,
      productId: "p2",
      code: "parecer_ia",
      name: "Parecer IA",
      kind: "addon",
      addonFor: ["consulta_pf"],
      effectiveCost: "1.00",
    };
    const switchTag = (active: boolean) =>
      render(true, [{ ...addon, item: { active, salePrice: "5.00" } }]).match(
        /<input[^>]*aria-label="Ativar Parecer IA"[^>]*>/,
      )?.[0];

    expect(switchTag(false)).toContain('disabled=""');
    expect(switchTag(true)).not.toContain('disabled=""');
  });
});
