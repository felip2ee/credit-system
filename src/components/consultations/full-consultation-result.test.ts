import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toFullConsultationView } from "@/lib/consultations/full-view";
import { FullConsultationResult } from "./full-consultation-result";

describe("FullConsultationResult", () => {
  const html = renderToStaticMarkup(createElement(FullConsultationResult, { view: toFullConsultationView(fixture)! }));
  it("shows the known cards", () => {
    for (const t of ["Parecer Smart", "SCR (Banco Central)", "Renda presumida", "Contatos e endereços"]) expect(html).toContain(t);
  });
  it("collapses the Smart history and lists missing modules", () => {
    expect(html).toContain("<details");
    expect(html).toContain("Sem informação:");
  });
  it("never renders the full CPF", () => {
    expect(html).not.toContain("52998224725");
    expect(html).not.toContain("529.982.247-25");
  });
});
