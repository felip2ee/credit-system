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

const render = (canWrite: boolean) =>
  renderToStaticMarkup(createElement(CatalogForm, { entries: [entry], canWrite }));

describe("CatalogForm", () => {
  it("shows warning when price is below cost", () => {
    expect(render(true)).toContain("Preço abaixo do custo");
  });

  it("disables controls without catalog:write", () => {
    const html = render(false);
    expect(html).not.toContain("Salvar");
    expect(html.match(/disabled=""/g)?.length).toBe(2); // price input + switch
  });
});
