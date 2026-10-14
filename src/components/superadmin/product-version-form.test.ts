import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/catalog", () => ({ createProductVersion: vi.fn() }));

import { moneyError } from "./money";
import { ProductVersionForm } from "./product-version-form";

describe("ProductVersionForm", () => {
  it("prefills current cost and DEPS name", () => {
    const html = renderToStaticMarkup(
      createElement(ProductVersionForm, {
        productId: "p1",
        currentDepsProduct: "Smart PF",
        currentBaseCost: "3.50",
      }),
    );
    expect(html).toContain('value="3.50"');
    expect(html).toContain('value="Smart PF"');
  });
  it("validates money with the shared schema (invalid shows error)", () => {
    expect(moneyError("-1")).not.toBeNull();
    expect(moneyError("3.50")).toBeNull();
  });
});
