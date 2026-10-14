import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ setBureauProductCost: vi.fn() }));

import { BureauCostsPanel } from "./bureau-costs-panel";

const base = {
  productId: "p1",
  code: "consulta_pf",
  name: "Consulta PF",
  kind: "main" as const,
  productActive: true,
  productVersionId: "v1",
  effectiveCost: "3.50",
  history: [],
};

describe("BureauCostsPanel", () => {
  it("shows source Override for an override row", () => {
    const html = renderToStaticMarkup(
      createElement(BureauCostsPanel, {
        bureauId: "b1",
        rows: [{ ...base, source: "override" as const }],
      }),
    );
    expect(html).toContain("Override");
    expect(html).not.toContain(">Padrão<");
  });
  it("shows source Padrão for a default row", () => {
    const html = renderToStaticMarkup(
      createElement(BureauCostsPanel, {
        bureauId: "b1",
        rows: [{ ...base, source: "default" as const }],
      }),
    );
    expect(html).toContain("Padrão");
  });
});
