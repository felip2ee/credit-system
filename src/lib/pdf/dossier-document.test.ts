import { describe, expect, it } from "vitest";

import pjFixture from "@/lib/deps/__fixtures__/pj-current.json";
import pfFixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { renderDossierPdf, type DossierEntry, type DossierPdfData } from "./dossier-document";
import { pdfText } from "./pdf-text.testing";

const FRAME = { bureauName: "Bureau Exemplo", supportEmail: "suporte@rainhacred.com.br", issuedAt: new Date("2026-10-19T15:00:00Z") };
const base = { data: "19/10/2026", consultante: "Rainha Cred", usuario: "u1" };

function entry(role: string, name: string, cpf: string, fixture: unknown, produto: string): DossierEntry {
  return {
    role,
    content: toConsultationContent(fixture, null),
    header: { ...base, name, cpf, produto, docLabel: role === "Empresa" ? "CNPJ" : "CPF" },
  };
}

const company = entry("Empresa", "Comercial Exemplo de Alimentos e Bebidas Ltda", "12.345.678/0001-90", pjFixture, "Smart PJ");
const partnerA = entry("Sócio", "Antonio Carlos Pereira de Albuquerque Neto", "***.111.222-**", pfFixture, "Smart PF");
const partnerB = entry("Sócio", "Beatriz Helena Fontes Cavalcanti de Souza", "***.333.444-**", pfFixture, "Smart PF");
const opinion = { aptitude: "apto", classificacao: null, resumo: "Resumo-consolidado-xyz", pontosFortes: [], pontosAtencao: [], planoAcao: [], modelo: "m", relatorioMarkdown: null };

const squash = (text: string): string => text.replace(/\s/g, "");
const count = (text: string, part: string): number => text.split(part).length - 1;
async function render(data: Partial<DossierPdfData> & Pick<DossierPdfData, "entries">): Promise<string> {
  return pdfText(await renderDossierPdf({ title: "Comercial Exemplo", subtitle: "12.345.678/0001-90 · 3 consulta(s)", report: null, ...data }, FRAME));
}

describe("renderDossierPdf", () => {
  it("lists a company and two partners on the cover and names each on its pages", async () => {
    const text = await render({ entries: [company, partnerA, partnerB], report: opinion });
    expect(text).toContain("EMPRESARIAL");
    expect(text).toContain("PAPEL");
    expect(count(text, "Empresa")).toBeGreaterThanOrEqual(1);
    expect(count(text, "Sócio")).toBeGreaterThanOrEqual(2);
    for (const e of [company, partnerA, partnerB]) expect(count(squash(text), squash(e.header.name))).toBeGreaterThanOrEqual(2);
    expect(count(text, "Documento gerado automaticamente")).toBe(1);
  }, 60_000);

  it("renders a one-member PF dossier with a cover and no opinion heading", async () => {
    const text = await render({ entries: [{ ...partnerA, role: "Titular" }], subtitle: "***.111.222-** · 1 consulta(s)" });
    expect(text).toContain("PESSOA FÍSICA");
    expect(text).toContain("Titular");
    expect(text).not.toContain("Parecer consolidado");
    expect(count(text, "Documento gerado automaticamente")).toBe(1);
  }, 30_000);

  it("prints the opinion summary after the member pages", async () => {
    const text = await render({ entries: [{ ...partnerA, role: "Titular" }], report: opinion });
    expect(text).toContain("Resumo-consolidado-xyz");
    expect(text).toContain("Parecer consolidado");
    expect(text).toContain("Titular · ");
    expect(count(text, "Documento gerado automaticamente")).toBe(1);
  }, 30_000);
});
