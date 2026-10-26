import { describe, expect, it } from "vitest";

import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import { toConsultationContent } from "@/lib/consultations/full-view";
import type { CanonicalBureauResult } from "@/types/bureau";
import { renderCompleteConsultationPdf } from "./complete-consultation-document";
import { pdfText } from "./pdf-text.testing";

const FRAME = { bureauName: "Bureau Exemplo", supportEmail: "suporte@rainhacred.com.br", issuedAt: new Date("2026-10-19T15:00:00Z") };
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Rainha Cred", usuario: "u1" };

function canonical(body: unknown): CanonicalBureauResult {
  const r = adapt(body, { product: DEPS_PRODUCT_PF, httpStatus: 200, receivedAt: new Date("2026-10-19T00:00:00Z") });
  if (!r.ok) throw new Error(`fixture did not adapt: ${JSON.stringify(r.errors)}`);
  return r.value;
}

describe("renderCompleteConsultationPdf", () => {
  it("prints the spec titles and the parts collapsed on screen", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, FRAME);
    const text = pdfText(pdf);
    for (const title of ["SCR", "Parecer Smart", "Renda presumida", "Histórico de classificação", "Todas as classificações"]) {
      expect(text, title).toContain(title);
    }
  }, 30_000);
  it("prints no bureau metadata and no missing-modules line", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, FRAME);
    const text = pdfText(pdf);
    for (const leak of ["deps.com.br", "Smart PF 002", "Dados da consulta", "Sem informa"]) expect(text, leak).not.toContain(leak);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }, 30_000);
  it("prints nested records as sub-tables under their row", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, FRAME);
    const text = pdfText(pdf);
    for (const label of ["Regras", "Positivas", "Negativas"]) expect(text, label).toContain(label);
    expect(text).not.toContain("[{");
  }, 30_000);
  it("renders the full payload view", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, FRAME);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
  it("renders the canonical fallback when there is no payload", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(null, canonical(fixture)), header, FRAME);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
