import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HowItWorks } from "./how-it-works";

describe("HowItWorks", () => {
  it("cita a taxa só quando ela existe", () => {
    const withFee = renderToStaticMarkup(createElement(HowItWorks, { fee: { fixed: "3.5", percent: "2" } }));
    const without = renderToStaticMarkup(createElement(HowItWorks, { fee: null }));

    expect(withFee).toMatch(/com taxa de R\$.*3,50.* \+ 2%/);
    expect(without).toContain("com taxa.");
    expect(without).not.toContain("com taxa de");
  });
});
