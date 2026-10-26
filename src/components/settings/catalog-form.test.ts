import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ upsertCatalogItem: vi.fn() }));

import { CatalogEditForm, CatalogForm } from "@/components/settings/catalog-form";
import type { CatalogEntry } from "@/lib/catalog/queries";

const entry: CatalogEntry = {
  productId: "p1",
  productVersionId: "v1",
  code: "dossie_pf",
  name: "Dossiê Pessoa Física",
  effectiveCost: "10.00",
  effectiveCostPerPartner: "0.00",
  item: { active: true, salePrice: "5.00", salePricePerPartner: "0.00" },
  sellable: false,
  onSale: false,
};

const empresarial: CatalogEntry = {
  ...entry,
  productId: "p2",
  code: "dossie_empresarial",
  name: "Dossiê Empresarial Estruturado",
  effectiveCost: "10.00",
  effectiveCostPerPartner: "4.00",
  item: { active: true, salePrice: "20.00", salePricePerPartner: "6.00" },
  sellable: true,
  onSale: true,
};

const renderList = (canWrite: boolean, entries: CatalogEntry[] = [entry]) =>
  renderToStaticMarkup(createElement(CatalogForm, { entries, canWrite }));
const render = (_canWrite: boolean, entries: CatalogEntry[] = [entry]) =>
  renderToStaticMarkup(createElement(CatalogEditForm, { entry: entries[0], onDone: vi.fn() }));

describe("CatalogForm", () => {
  it("shows warning when price is below cost", () => {
    expect(render(true)).toContain("Preço abaixo do custo");
  });

  it("list is read-only: shows prices, no inputs; Editar only with catalog:write", () => {
    const html = renderList(true);
    expect(html).toContain("Dossiê Pessoa Física");
    expect(html).toContain("Editar");
    expect(html).not.toContain("<input");
    expect(renderList(false)).not.toContain("Editar");
  });

  it("does not warn when the cost is 0.00 (zero cost is valid)", () => {
    const html = render(true, [{ ...entry, effectiveCost: "0.00" }]);
    expect(html).not.toContain("abaixo do custo");
  });

  it("Dossiê Pessoa Física shows only 'Valor', not 'Valor por sócio'", () => {
    const html = render(true);
    expect(html).not.toContain("Valor por sócio");
    expect(html).not.toContain("Valor da empresa");
    expect(html).toContain("Valor");
  });

  it("Dossiê Empresarial shows company and per-partner values", () => {
    const html = render(true, [empresarial]);
    expect(html).toContain("Valor da empresa");
    expect(html).toContain("Valor por sócio");
    expect(html).not.toContain("abaixo do custo");
  });

  it("per-partner price below partner cost warns on the per-partner field only", () => {
    const html = render(true, [
      { ...empresarial, item: { active: true, salePrice: "20.00", salePricePerPartner: "1.00" } },
    ]);
    expect(html).toContain("Valor por sócio abaixo do custo");
    expect(html).not.toContain("Preço abaixo do custo");
  });
});
