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
  return { text: pdfText(pdf), pages: (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length };
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
});
