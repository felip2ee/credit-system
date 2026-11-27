import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AffiliateBalance } from "./affiliate-balance";

const wallet = { pending: "3.00", available: "7.00" };
const render = (props: Parameters<typeof AffiliateBalance>[0]) => renderToStaticMarkup(createElement(AffiliateBalance, props));

describe("AffiliateBalance", () => {
  it("modo Pix: mantém comissão disponível e carência", () => {
    const html = render({ method: "pix", wallet, asaasReceived: { cents: 999, reversalFailedCents: 0 } });

    expect(html).toContain("Comissão disponível");
    expect(html).toContain("Em carência");
    expect(html).not.toContain("Recebido pelo Asaas");
  });

  it("modo Asaas: um cartão com o total em centavos, sem carência nem disponível", () => {
    const html = render({ method: "asaas", wallet, asaasReceived: { cents: 1583, reversalFailedCents: 0 } });

    expect(html).toContain("Recebido pelo Asaas");
    expect(html).toMatch(/R\$.*15,83/);
    expect(html).not.toMatch(/carência|Comissão disponível/);
    expect(html).not.toContain("estornados");
  });

  it("modo Asaas: avisa do repasse estornado sem devolução quando existe", () => {
    const html = render({ method: "asaas", wallet, asaasReceived: { cents: 1583, reversalFailedCents: 250 } });

    expect(html).toContain("de repasses estornados sem devolução");
    expect(html).toMatch(/Inclui.*R\$.*2,50/);
  });
});
