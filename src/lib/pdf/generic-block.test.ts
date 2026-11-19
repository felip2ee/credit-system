import { createElement } from "react";
import { Document, Page, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import type { GenericValue } from "@/types/consultation-view";

import { PdfGenericValue } from "./generic-block";
import { pdfText } from "./pdf-text.testing";
import { PDF_PAGE } from "./theme";
import { registerPdfFonts } from "./fonts";

async function render(value: GenericValue): Promise<{ text: string; pages: number }> {
  registerPdfFonts();
  const doc = createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: { paddingTop: PDF_PAGE.paddingTop, paddingBottom: PDF_PAGE.paddingBottom, paddingHorizontal: PDF_PAGE.paddingX } },
      createElement(PdfGenericValue, { value }),
    ),
  );
  const pdf = await renderToBuffer(doc);
  // Valor em R$ usa espaço sem quebra entre o símbolo e o número; o teste compara o texto visível.
  return { text: pdfText(pdf).replace(/\u00A0/g, " "), pages: (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("PdfGenericValue", () => {
  it("prints every label and value of a list of objects, the header once per page", async () => {
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Nome completo" }, { key: "b", label: "Valor" }],
      rows: Array.from({ length: 5 }, (_, i) => ({ cells: [`Pessoa ${i}`, `R$ ${i + 1},00`], nested: [] })),
    };
    const { text } = await render(value);
    for (const t of ["NOME COMPLETO", "VALOR", "Pessoa 0", "Pessoa 4", "R$ 5,00"]) expect(text, t).toContain(t);
    expect(count(text, "NOME COMPLETO")).toBe(1);
  }, 30_000);

  it("repeats the header only after a real page break and loses no row", async () => {
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Nome completo" }, { key: "b", label: "Valor" }],
      rows: Array.from({ length: 60 }, (_, i) => ({ cells: [`Linha${i}x`, `R$ ${i},00`], nested: [] })),
    };
    const { text, pages } = await render(value);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(count(text, "NOME COMPLETO")).toBe(pages);
    for (const i of [0, 30, 59]) expect(text).toContain(`Linha${i}x`);
  }, 30_000);

  it("keeps a nested list and a long token inside the page", async () => {
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Item" }],
      rows: [
        {
          cells: ["Pai"],
          nested: [
            {
              label: "Filhos",
              value: {
                kind: "table",
                columns: [{ key: "c", label: "Doc" }],
                rows: [{ cells: ["9".repeat(60)], nested: [] }],
              },
            },
          ],
        },
      ],
    };
    const { text } = await render(value);
    expect(text).toContain("Filhos");
    expect(text).toContain("DOC");
    expect(text.replace(/\s/g, "")).toContain("9".repeat(60));
  }, 30_000);

  it("breaks between rows when many rows carry a nested table, and loses nothing", async () => {
    const nested = {
      kind: "table" as const,
      columns: [{ key: "n", label: "Descrição" }, { key: "v", label: "Valor" }],
      rows: Array.from({ length: 6 }, (_, j) => ({ cells: [`Filho ${j}`, `R$ ${j},00`], nested: [] })),
    };
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Item" }],
      rows: Array.from({ length: 14 }, (_, i) => ({ cells: [`Pai${i}x`], nested: [{ label: `Sub${i}x`, value: nested }] })),
    };
    const { text, pages } = await render(value);
    // 14 blocos de ~170 pt em páginas de ~640 pt: antes saíam apertados em 2 páginas, sobrepostos.
    expect(pages).toBeGreaterThanOrEqual(4);
    for (const i of [0, 7, 13]) {
      expect(text).toContain(`Pai${i}x`);
      expect(text).toContain(`Sub${i}x`);
    }
    expect(count(text, "Filho 5")).toBe(14);
  }, 30_000);

  it("lets a row with a very long cell split across pages instead of overflowing", async () => {
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Texto" }, { key: "b", label: "Valor" }],
      rows: [
        { cells: ["antes", "R$ 1,00"], nested: [] },
        { cells: ["palavra ".repeat(1500), "R$ 2,00"], nested: [] },
        { cells: ["depois", "R$ 3,00"], nested: [] },
      ],
    };
    const { text, pages } = await render(value);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(text).toContain("antes");
    expect(text).toContain("depois");
  }, 30_000);

  it("keeps a 2000-character cell in one piece", async () => {
    const value: GenericValue = {
      kind: "table",
      columns: [{ key: "a", label: "Texto" }],
      rows: [{ cells: ["palavra ".repeat(250)], nested: [] }],
    };
    const { pages } = await render(value);
    expect(pages).toBe(1);
  }, 30_000);
});
