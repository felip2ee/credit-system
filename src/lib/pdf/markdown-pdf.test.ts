import { createElement } from "react";
import { Document, Page, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { registerPdfFonts } from "./fonts";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";
import { pdfText } from "./pdf-text.testing";
import { PDF_PAGE } from "./theme";

async function render(opinion: OpinionForPdf): Promise<string> {
  registerPdfFonts();
  const doc = createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: { paddingTop: PDF_PAGE.paddingTop, paddingBottom: PDF_PAGE.paddingBottom, paddingHorizontal: PDF_PAGE.paddingX } },
      createElement(OpinionBlock, { opinion }),
    ),
  );
  return pdfText(await renderToBuffer(doc));
}

const base: OpinionForPdf = { aptitude: "apt", pontosFortes: [], pontosAtencao: [], planoAcao: [] };
const structured: OpinionForPdf = {
  ...base,
  classificacao: "Conservador",
  limiteSugerido: 15000,
  limiteNotas: "Revisar o limite em 90 dias",
  resumo: "Resumo da análise",
  pontosFortes: [{ title: "Pagador pontual", description: "Sem atrasos" }],
  pontosAtencao: [{ title: "Renda variável", description: "Oscila", severity: "média" }],
  planoAcao: [{ step: "Pedir extratos", description: "Seis meses", priority: "alta" }],
};
const report = "# Parecer técnico\n\nTexto do relatório.\n\n| Item | Situação | Valor |\n|---|---|---|\n| Faturamento | Ativo | R$ 12.500,00 |\n";

describe("OpinionBlock", () => {
  it("prints every part when structured fields and report coexist", async () => {
    const text = await render({ ...structured, relatorioMarkdown: report });
    for (const t of ["Resumo da análise", "Pagador pontual", "Renda variável", "Pedir extratos", "Revisar o limite em 90 dias", "Parecer técnico"]) {
      expect(text, t).toContain(t);
    }
  }, 30_000);

  it("renders only the report without headings for missing parts", async () => {
    const text = await render({ ...base, relatorioMarkdown: report });
    expect(text).toContain("Parecer técnico");
    for (const t of ["Pontos fortes", "Pontos de atenção", "Plano de ação", "Resumo"]) expect(text, t).not.toContain(t);
  }, 30_000);

  it("renders structured fields without a report section", async () => {
    const text = await render(structured);
    expect(text).toContain("Pagador pontual");
    expect(text).not.toContain("Parecer técnico");
  }, 30_000);

  it("renders a markdown table with a money column", async () => {
    const text = await render({ ...base, relatorioMarkdown: report });
    for (const t of ["Faturamento", "Ativo", "R$ 12.500,00"]) expect(text, t).toContain(t);
  }, 30_000);
});
