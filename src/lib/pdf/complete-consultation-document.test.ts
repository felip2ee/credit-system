import { createElement } from "react";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import pjFixture from "@/lib/deps/__fixtures__/pj-current.json";
import pfFixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import { toConsultationContent, type ConsultationContent } from "@/lib/consultations/full-view";
import { addressLine } from "./sections/cells";
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

// Só espaço em branco some na comparação (quebra de linha do layout); sinal, separador e "%" contam.
const flat = (text: string): string => text.replace(/\s/g, "");
const squash = (text: string): string => text.replace(/[^A-Za-z0-9\u00C0-\u00FF]/g, "");

// Formatos documentados que o PDF aplica a um valor da API:
// - percentual com duas casas ("25" vira "25,00%", "97.13%" vira "97,13%");
// - pontuação positiva com sinal ("6" vira "+6");
// - prefixo "— " de detalhe do SCR vira recuo (o texto sai sem ele);
// - situação "Sim"/"Não" de um grupo de regras sai como "Atendido"/"Não atendido".
const PERCENT_WORD = /^-?\d+(?:,\d+)?%$/;
function variants(item: string): string[] {
  const plain = flat(item);
  const percent = plain.replace(/%/g, "").replace(/^(-?\d+)\.(\d+)$/, "$1,$2");
  const padded = /^-?\d+$/.test(percent) ? `${percent},00` : /^-?\d+,\d$/.test(percent) ? `${percent}0` : percent;
  const group = plain === "Sim" ? "Atendido" : plain === "Não" ? "Nãoatendido" : plain;
  return Array.from(new Set([plain, `${padded}%`, /^\d/.test(plain) ? `+${plain}` : plain, plain.replace(/^—/, ""), group]));
}

// Todo valor e todo rótulo de campo que a visão entrega ao documento, com o rótulo das linhas aninhadas.
// Duas composições documentadas: o endereço sai numa linha só (`addressLine`) e a lista de e-mails sai um por linha.
function leaves(value: GenericValue, out: string[]): void {
  if (value.kind === "text" || value.kind === "json") {
    value.text.split("\n").forEach((line) => out.push(...(line.includes("@") ? line.split(", ") : [line])));
  } else if (value.kind === "fields") value.fields.forEach((field) => (out.push(field.label), leaves(field.value, out)));
  else
    value.rows.forEach((row, r) => {
      if (value.columns.some((column) => column.key === "endereco")) out.push(addressLine(value, r));
      else out.push(...row.cells);
      row.nested.forEach((n) => (out.push(n.label), leaves(n.value, out)));
    });
}
function sectionItems(section: FullSection): string[] {
  const out: string[] = [];
  section.parts.forEach((part) => (part.title && out.push(part.title), leaves(part.value, out)));
  return out;
}
function genericItems(full: FullConsultationView): string[] {
  const out: string[] = [];
  full.generic.forEach((block) => (out.push(block.title), block.note && out.push(block.note), leaves(block.value, out)));
  return out;
}
// Isenções, cada uma coberta de outra forma:
// - "Score" e "Descrição": o número e a descrição saem na trilha de risco e no resumo, sem rótulo de campo.
// - "Resultado do parecer": não tem título próprio; cada grupo de regras abre com o nome e o estado dele.
// - "Regras": rótulo do contêiner de regras de cada grupo; o nome do grupo e as linhas de regra o substituem.
// - "—": marca de "sem valor"; a tabela descarta a coluna vazia e o resumo mostra o traço dele mesmo.
const EXEMPT = new Set(["Score", "Descrição", "Resultado do parecer", "Regras", "—"]);
// Valor de até SHORT chars é conferido por linha inteira (cada célula é uma linha do texto do PDF); o resto, por trecho.
const SHORT = 3;

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// Quantas vezes uma forma percentual ("100,00%") aparece, sem colar em outro número.
function percentHits(lines: string[], forms: string[]): number {
  const joined = lines.join("\n");
  return forms
    .filter((form) => PERCENT_WORD.test(form))
    .reduce((sum, form) => sum + joined.split(new RegExp(`(?<![\\d,.])${form.replace(/[.+]/g, "\\$&")}`)).length - 1, 0);
}

// Cada valor aparece no PDF ao menos tantas vezes quanto aparece na origem, dentro do texto da própria seção.
function missingIn(items: string[], text: string): string[] {
  const lines = text.split("\n").map(flat);
  const printed = flat(text);
  const wanted = new Map<string, number>();
  for (const item of items) if (!EXEMPT.has(item) && flat(item) !== "") wanted.set(item, (wanted.get(item) ?? 0) + 1);
  const missing: string[] = [];
  wanted.forEach((needed, item) => {
    const forms = variants(item);
    // Percentual curto ("100") também sai dentro da nota do grupo ("100,00% de 100,00%"): conta o trecho, não a linha.
    const found =
      flat(item).length <= SHORT
        ? lines.filter((line) => forms.includes(line) && !PERCENT_WORD.test(line)).length + percentHits(lines, forms)
        : forms.reduce((best, form) => Math.max(best, count(printed, form)), 0);
    if (found < needed) missing.push(`${item} (esperado ${needed}, achado ${found})`);
  });
  return missing;
}

async function expectNothingLost(content: ConsultationContent): Promise<void> {
  const full = content.full as FullConsultationView;
  const lost: string[] = [];
  for (const section of full.sections) {
    const text = await render({ ...content, full: { ...full, sections: [section], generic: [] } });
    lost.push(...missingIn(sectionItems(section), text).map((m) => `${section.id}: ${m}`));
  }
  if (full.generic.length > 0) {
    const text = await render({ ...content, full: { ...full, sections: [], generic: full.generic } });
    lost.push(...missingIn(genericItems(full), text).map((m) => `generic: ${m}`));
  }
  expect(lost).toEqual([]);
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
    await expectNothingLost(toConsultationContent(fixture, null));
  }, 120_000);

  it("prints a lone percentual esperado and a score on a band limit with the API risk label", async () => {
    const full = structuredClone(toConsultationContent(pfFixture, null).full) as FullConsultationView;
    const smart = full.sections.find((section) => section.id === "smart");
    const result = smart?.parts.find((part) => part.title === "Resultado do parecer")?.value;
    if (result?.kind !== "table") throw new Error("fixture lost its result table");
    const at = (key: string): number => result.columns.findIndex((column) => column.key === key);
    result.rows[0].cells[at("percentual")] = "—";
    result.rows[0].cells[at("percentualEsperado")] = "77,77 %";
    expect(squash(await render({ full, view: null }))).toContain("7777");
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
