import { createElement } from "react";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import pjFixture from "@/lib/deps/__fixtures__/pj-current.json";
import pfFixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import { toConsultationContent, type ConsultationContent } from "@/lib/consultations/full-view";
import type { CanonicalBureauResult } from "@/types/bureau";
import type { FullConsultationView, FullSection, GenericValue } from "@/types/consultation-view";
import { ConsultationPdfPage, renderCompleteConsultationPdf } from "./complete-consultation-document";
import { pdfText } from "./pdf-text.testing";

const FRAME = { bureauName: "Bureau Exemplo", supportEmail: "suporte@rainhacred.com.br", issuedAt: new Date("2026-10-19T15:00:00Z") };
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Rainha Cred", usuario: "u1" };
const EMPTY_VIEW: FullConsultationView = { sections: [], generic: [], missing: [], meta: [], scoreValue: null };

function canonical(body: unknown): CanonicalBureauResult {
  const r = adapt(body, { product: DEPS_PRODUCT_PF, httpStatus: 200, receivedAt: new Date("2026-10-19T00:00:00Z") });
  if (!r.ok) throw new Error(`fixture did not adapt: ${JSON.stringify(r.errors)}`);
  return r.value;
}

// Compara só letras e dígitos: quebra de linha, hifenização e pontuação do layout não contam.
const squash = (text: string): string => text.replace(/[^A-Za-z0-9\u00C0-\u00FF]/g, "");
// Percentual sai com duas casas: "25" vira "25,00" e "46,1" vira "46,10".
const pad2 = (text: string): string => (/^-?\d+$/.test(text) ? `${text},00` : /^-?\d+,\d$/.test(text) ? `${text}0` : text);

// Todo valor e todo rótulo de campo que a visão entrega ao documento.
function leaves(value: GenericValue, out: string[]): void {
  if (value.kind === "text" || value.kind === "json") out.push(...value.text.split("\n"));
  else if (value.kind === "fields") value.fields.forEach((field) => (out.push(field.label), leaves(field.value, out)));
  else value.rows.forEach((row) => (out.push(...row.cells), row.nested.forEach((n) => leaves(n.value, out))));
}
function collect(full: FullConsultationView): string[] {
  const out: string[] = [];
  full.sections.forEach((section) => section.parts.forEach((part) => (part.title && out.push(part.title), leaves(part.value, out))));
  full.generic.forEach((block) => (out.push(block.title), block.note && out.push(block.note), leaves(block.value, out)));
  return out;
}
// Rótulos que o desenho cobre de outra forma: o número do score e a descrição saem na trilha, sem rótulo de campo.
// "Resultado do parecer" não tem título próprio: cada grupo de regras abre com o nome e o estado dele.
const EXEMPT = new Set(["Score", "Descrição", "Resultado do parecer"]);

function expectNothingLost(content: ConsultationContent, text: string): void {
  const printed = squash(text);
  const missing = collect(content.full as FullConsultationView)
    .filter((item) => !EXEMPT.has(item) && squash(item) !== "")
    .filter((item) => ![squash(item), squash(pad2(item.replace(/%|\s/g, "")))].some((variant) => printed.includes(variant)));
  expect(missing).toEqual([]);
}

async function render(content: ConsultationContent, extra: Record<string, unknown> = {}): Promise<string> {
  const doc = createElement(Document, null, createElement(ConsultationPdfPage, { ...content, header, frame: FRAME, ...extra }));
  return pdfText(await renderToBuffer(doc));
}

describe("renderCompleteConsultationPdf", () => {
  it("prints the spec titles and the parts collapsed on screen", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(pfFixture, null), header, FRAME);
    const text = pdfText(pdf);
    for (const title of ["SCR", "Parecer Smart", "Renda presumida", "Histórico de classificação", "Todas as classificações"]) {
      expect(text, title).toContain(title);
    }
  }, 30_000);
  it("prints no bureau metadata and no missing-modules line", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(pfFixture, null), header, FRAME);
    const text = pdfText(pdf);
    for (const leak of ["deps.com.br", "Smart PF 002", "Dados da consulta", "Sem informa"]) expect(text, leak).not.toContain(leak);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }, 30_000);
  it("prints nested records under their group", async () => {
    const text = await render(toConsultationContent(pfFixture, null));
    for (const label of ["Positivas", "Negativas"]) expect(text, label).toContain(label);
    expect(text).not.toContain("[{");
  }, 30_000);
  it("renders the canonical fallback when there is no payload", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(null, canonical(pfFixture)), header, FRAME);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});

describe("nothing is lost", () => {
  it.each([
    ["PF", pfFixture],
    ["PJ", pjFixture],
  ])("prints every label and value the %s view carries", async (_name, fixture) => {
    const content = toConsultationContent(fixture, null);
    expectNothingLost(content, await render(content));
  }, 30_000);

  it("prints a section with an unknown key through the generic path", async () => {
    const unknown: FullSection = {
      id: "secaoNova" as FullSection["id"],
      title: "Seção nova da API",
      sources: ["secaoNova"],
      parts: [{ title: "Parte nova", value: { kind: "fields", fields: [{ key: "campoNovo", label: "Campo novo", value: { kind: "text", text: "valor-inesperado-42" } }] }, collapsed: false }],
    };
    const text = await render({ full: { ...EMPTY_VIEW, sections: [unknown] }, view: null });
    for (const item of ["Seção nova da API", "Parte nova", "Campo novo", "valor-inesperado-42"]) expect(squash(text), item).toContain(squash(item));
  }, 30_000);

  it("renders content with no score, no SCR and no rules, with at most five dashes in the summary", async () => {
    const text = await render({ full: EMPTY_VIEW, view: null });
    expect(text).toContain(header.name);
    expect(text.split("\n").filter((line) => /^[\u0097—]$/.test(line)).length).toBeLessThanOrEqual(5);
  }, 30_000);

  it("falls back to the generic path when a curated section has an unexpected shape", async () => {
    const odd: FullSection = {
      id: "smart",
      title: "Parecer Smart",
      sources: ["smart"],
      parts: [{ title: "Resultado do parecer", value: { kind: "text", text: "forma-inesperada" }, collapsed: false }],
    };
    expect(squash(await render({ full: { ...EMPTY_VIEW, sections: [odd] }, view: null }))).toContain("formainesperada");
  }, 30_000);
});

describe("page header and closing note", () => {
  const content = toConsultationContent(pfFixture, null);
  it("omits the internal user id when it is a UUID and prints a user name", async () => {
    const uuid = "3f2b8c1e-9d4a-4b7e-8a61-0c5d2e9f7a11";
    expect(await render(content, { header: { ...header, usuario: uuid } })).not.toContain("Usuário");
    expect(await render(content, { header: { ...header, usuario: "Ana Souza" } })).toContain("Usuário Ana Souza");
  }, 30_000);
  it("prints the role in the eyebrow", async () => {
    expect(await render(content, { roleLabel: "Sócio" })).toContain("Sócio · ");
  }, 30_000);
  it("omits the closing note on request", async () => {
    expect(await render(content)).toContain("Documento gerado automaticamente");
    expect(await render(content, { closingNote: false })).not.toContain("Documento gerado automaticamente");
  }, 30_000);
});
