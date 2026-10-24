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
  it("collapses the Smart history", () => {
    expect(html).toContain("<details");
  });
  it("never shows bureau metadata, missing modules or identifiers", () => {
    for (const leak of ["Dados da consulta", "Sem informação", "deps.com.br", "Smart PF 002"]) expect(html).not.toContain(leak);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
  it("never renders the full CPF", () => {
    expect(html).not.toContain("52998224725");
    expect(html).not.toContain("529.982.247-25");
  });
});
