import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { renderCompleteConsultationPdf } from "./complete-consultation-document";
import { renderDossierPdf } from "./dossier-document";
import { pdfText } from "./pdf-text.testing";

const SUPPORT_EMAIL = "suporte@rainhacred.com.br";
const BUREAU_NAME = "Bureau Exemplo";
const LONG_BUREAU_NAME = "Associacao Nacional de Consultoria de Credito e Servicos Financeiros";
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Rainha Cred", usuario: "u1" };
const frameFor = (bureauName: string) => ({ bureauName, supportEmail: SUPPORT_EMAIL, issuedAt: new Date("2026-10-19T15:00:00Z") });
const content = () => toConsultationContent(fixture, null);

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "fonts" ? [] : listSources(full);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
  });
}

describe("Rainha Cred PDF frame", () => {
  it("prints bureau name, support email and page counter on every document", async () => {
    const consultation = pdfText(await renderCompleteConsultationPdf(content(), header, frameFor(BUREAU_NAME)));
    const dossier = pdfText(
      await renderDossierPdf({ title: "Maria", subtitle: "1 consulta(s)", entries: [{ content: content(), header, role: "Titular" }], report: null }, frameFor(BUREAU_NAME)),
    );
    for (const text of [consultation, dossier]) {
      expect(text).toContain(BUREAU_NAME);
      expect(text).toContain(SUPPORT_EMAIL);
      expect(text).toMatch(/Página 1 de \d+/);
      expect(text).not.toContain("Reino do Crédito");
      expect(text).not.toMatch(/instagram/i);
    }
  }, 60_000);

  it("renders a 60+ character bureau name without losing words", async () => {
    const text = pdfText(await renderCompleteConsultationPdf(content(), header, frameFor(LONG_BUREAU_NAME)));
    for (const word of LONG_BUREAU_NAME.split(" ")) expect(text, word).toContain(word);
  }, 60_000);

  it("keeps the letterhead out of every pdf source", () => {
    const offenders = listSources(__dirname).filter((f) => /letterhead|Helvetica/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
