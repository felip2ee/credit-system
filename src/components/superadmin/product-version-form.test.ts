import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ createProductVersion: vi.fn() }));

import { moneyError } from "@/lib/catalog/money-input";
import { ProductVersionForm } from "./product-version-form";

describe("ProductVersionForm", () => {
  it("prefills current cost and DEPS name", () => {
    const html = renderToStaticMarkup(
      createElement(ProductVersionForm, {
        productId: "p1",
        productCode: "dossie_pf",
        currentDepsProduct: "Smart PF",
        currentBaseCost: "3.50",
        currentBaseCostPerPartner: "0.00",
      }),
    );
    expect(html).toContain('value="3.50"');
    expect(html).toContain('value="Smart PF"');
    expect(html).not.toContain("por sócio");
  });
  it("shows the per-partner cost only for Dossiê Empresarial", () => {
    const html = renderToStaticMarkup(
      createElement(ProductVersionForm, {
        productId: "p2",
        productCode: "dossie_empresarial",
        currentDepsProduct: null,
        currentBaseCost: "10.00",
        currentBaseCostPerPartner: "4.00",
      }),
    );
    expect(html).toContain("Custo padrão por sócio");
    expect(html).toContain('value="4.00"');
  });
  it("validates money with the shared schema (invalid shows error)", () => {
    expect(moneyError("-1")).not.toBeNull();
    expect(moneyError("3.50")).toBeNull();
  });
});
