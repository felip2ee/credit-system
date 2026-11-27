import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HowItWorks } from "./how-it-works";

const render = (props: Parameters<typeof HowItWorks>[0]) => renderToStaticMarkup(createElement(HowItWorks, props));

describe("HowItWorks", () => {
  it("modo Pix: cita a taxa (vírgula decimal) só quando ela existe", () => {
    const withFee = render({ fee: { fixed: "3.5", percent: "2.00" }, method: "pix" });
    const without = render({ fee: null, method: "pix" });

    expect(withFee).toMatch(/com taxa de R\$.*3,50.* \+ 2,00%/);
    expect(without).toContain("com taxa.");
    expect(without).not.toContain("com taxa de");
  });

  it("descreve comissão sobre a recarga, não sobre pesquisa nem preço bruto", () => {
    const html = render({ fee: null, method: "pix" });

    expect(html).toContain("recarrega");
    expect(html).toContain("valor líquido");
    expect(html).not.toMatch(/pesquisa|bruto/);
  });

  it("modo Asaas: não promete carência, conversão nem saque", () => {
    const html = render({ fee: { fixed: "3.5", percent: "2.00" }, method: "asaas" });

    expect(html).toContain("conta Asaas");
    expect(html).not.toMatch(/Converta|saque por PIX|em carência por alguns/);
    expect(html).not.toContain("com taxa");
  });
});
