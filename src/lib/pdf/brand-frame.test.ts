import { createElement } from "react";
import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { PdfBrandFrame, runningIdentity, type PdfFrame } from "./brand-frame";
import { estimateTextWidth } from "./table-layout";
import { renderCompleteConsultationPdf } from "./complete-consultation-document";
import { pdfText } from "./pdf-text.testing";

const SUPPORT_EMAIL = "suporte@rainhacred.com.br";
const baseFrame: PdfFrame = { bureauName: "Bureau Exemplo", supportEmail: SUPPORT_EMAIL, issuedAt: new Date("2026-10-19T15:00:00Z") };
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Rainha Cred", usuario: "u1" };

// `pages` elementos <Page>, cada um com `physical` páginas físicas (View com quebra).
async function renderPages(frame: PdfFrame, pages = 2, physical = 1): Promise<string[]> {
  const doc = createElement(
    Document,
    null,
    ...Array.from({ length: pages }, (_, i) =>
      createElement(
        Page,
        { key: i, size: "A4" },
        createElement(PdfBrandFrame, { frame }),
        ...Array.from({ length: physical }, (_, j) => createElement(View, { key: j, break: j > 0 }, createElement(Text, null, `Conteudo ${i + 1}-${j + 1}`))),
      ),
    ),
  );
  const text = pdfText(await renderToBuffer(doc));
  // Cada página é um stream que termina no rodapé "Página X de Y": separa depois dele.
  return text.split(/(?<=Página \d+ de \d+)/).filter((p) => p.trim());
}

describe("Rainha Cred PDF frame", () => {
  it("shows only the e-mail when WhatsApp and Instagram are absent", async () => {
    const text = (await renderPages(baseFrame)).join("\n");
    expect(text).toContain(SUPPORT_EMAIL);
    expect(text).not.toMatch(/WhatsApp|Instagram/);
  }, 60_000);

  it("shows e-mail, WhatsApp and Instagram when present", async () => {
    const text = (await renderPages({ ...baseFrame, whatsapp: "(11) 90000-0000", instagram: "@rainhacred" })).join("\n");
    expect(text).toContain(SUPPORT_EMAIL);
    expect(text).toContain("WhatsApp (11) 90000-0000");
    expect(text).toContain("Instagram @rainhacred");
  }, 60_000);

  it("prints the page counter on a 2-page document", async () => {
    const text = (await renderPages(baseFrame)).join("\n");
    expect(text).toContain("Página 1 de 2");
    expect(text).toContain("Página 2 de 2");
  }, 60_000);

  it("prints the running line from page 2 on, not on page 1", async () => {
    const frame = { ...baseFrame, running: { name: "Maria Exemplo", document: "***.982.247-**", label: "Relatório de consulta" } };
    const text = (await renderPages(frame, 1, 2)).join("\n");
    expect(text.split("Maria Exemplo").length - 1).toBe(1);
    expect(text).toContain("Relatório de consulta (continuação)");
    expect(text.split("(continuação)").length - 1).toBe(1);
  }, 60_000);

  it("hides the running line on the first physical page of each <Page> and shows it on continuations", async () => {
    const running = { name: "Nome Corrente", document: "***.982.247-**", label: "Relatório" };
    const pages = await renderPages({ ...baseFrame, running }, 2, 2);
    // O corpo não segue a ordem das páginas no stream; o rodapé identifica a página física (1-2 = 1ª <Page>, 3-4 = 2ª).
    const runningPages = pages.filter((p) => p.includes("Nome Corrente")).map((p) => Number(/Página (\d+) de 4/.exec(p)?.[1]));
    expect(runningPages.sort()).toEqual([2, 4]);
  }, 60_000);

  it("shortens a long name on one line and keeps the document", async () => {
    const name = "Antonio Carlos Pereira de Albuquerque Neto Filho de Souza Cavalcanti Rodrigues Machado Lim";
    expect(name).toHaveLength(90);
    const frame = { ...baseFrame, running: { name, document: "CPF ***.111.222-**", label: "Sócio" } };
    expect(runningIdentity(frame.running)).toMatch(/^Antonio.*…  ·  CPF \*\*\*\.111\.222-\*\*$/);
    expect(runningIdentity(frame.running).length).toBeLessThanOrEqual(56);
    const text = (await renderPages(frame, 1, 2)).join("\n");
    expect(text).not.toContain(name);
    expect(text).toContain("CPF ***.111.222-**");
  }, 60_000);

  it("fits the running line by width, not by character count", () => {
    const budget = 330;
    const upper = runningIdentity({ name: "A".repeat(56) });
    expect(upper.endsWith("…")).toBe(true);
    expect(estimateTextWidth(upper, 10.5, true)).toBeLessThanOrEqual(budget);
    const upperDoc = runningIdentity({ name: "A".repeat(56), document: "CNPJ 12.345.678/0001-90" });
    expect(estimateTextWidth(upperDoc, 10.5, true)).toBeLessThanOrEqual(budget);
    expect(upperDoc.endsWith("CNPJ 12.345.678/0001-90")).toBe(true);
    // Minúsculas estreitas cabem em mais caracteres que maiúsculas.
    expect(runningIdentity({ name: "i".repeat(80) }).length).toBeGreaterThan(upper.length);
    expect(runningIdentity({ name: "Maria Exemplo" })).toBe("Maria Exemplo");
  });

  it("prints no dangling separator when the name or the document is missing", () => {
    expect(runningIdentity({ name: "", document: "123.456.789-00" })).toBe("123.456.789-00");
    expect(runningIdentity({ name: "   ", document: "123.456.789-00" })).toBe("123.456.789-00");
    expect(runningIdentity({ name: "Maria", document: "" })).toBe("Maria");
    expect(runningIdentity({ name: "Maria", document: "123" })).toBe("Maria  ·  123");
  });

  it("keeps the frame on a real consultation PDF", async () => {
    const text = pdfText(await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, baseFrame));
    expect(text).toContain(SUPPORT_EMAIL);
    expect(text).toMatch(/Página 1 de \d+/);
  }, 60_000);
});
