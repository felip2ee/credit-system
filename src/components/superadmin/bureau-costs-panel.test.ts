import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ setBureauProductCost: vi.fn() }));

import { BureauCostsPanel, buildBureauCostInput } from "./bureau-costs-panel";

const base = {
  productId: "p1",
  code: "dossie_pf",
  name: "Dossiê Pessoa Física",
  productActive: true,
  productVersionId: "v1",
  effectiveCost: "3.50",
  effectiveCostPerPartner: "0.00",
  history: [],
};

const render = (row: object) =>
  renderToStaticMarkup(createElement(BureauCostsPanel, { bureauId: "b1", rows: [row as never] }));

describe("BureauCostsPanel", () => {
  it("shows source Override for an override row", () => {
    const html = render({ ...base, source: "override" as const });
    expect(html).toContain("Override");
    expect(html).not.toContain(">Padrão<");
  });
  it("shows source Padrão for a default row", () => {
    expect(render({ ...base, source: "default" as const })).toContain("Padrão");
  });
  it("shows the per-partner cost field only for Dossiê Empresarial", () => {
    expect(render({ ...base, source: "default" })).not.toContain("por sócio");
    const html = render({ ...base, code: "dossie_empresarial", source: "default" });
    expect(html).toContain("Novo custo por sócio");
  });
});

describe("buildBureauCostInput", () => {
  it("sends cost and costPerPartner for Dossiê Empresarial", () => {
    expect(
      buildBureauCostInput("b1", { productId: "p2", code: "dossie_empresarial" }, "10,50", "4,25"),
    ).toEqual({ bureauId: "b1", productId: "p2", cost: "10.50", costPerPartner: "4.25" });
  });
  it("sends costPerPartner 0.00 for Dossiê Pessoa Física", () => {
    expect(
      buildBureauCostInput("b1", { productId: "p1", code: "dossie_pf" }, "3,50", "9"),
    ).toEqual({ bureauId: "b1", productId: "p1", cost: "3.50", costPerPartner: "0.00" });
  });
});
