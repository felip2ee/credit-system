import { createElement } from "react";
import { Document, Page, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it, vi } from "vitest";

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
    // A tabela cola "R$" ao valor com espaço sem quebra: a comparação não distingue os dois espaços.
    const text = (await render({ ...base, relatorioMarkdown: report })).replace(/\u00a0/g, " ");
    for (const t of ["Faturamento", "Ativo", "R$ 12.500,00"]) expect(text, t).toContain(t);
  }, 30_000);

  it("keeps every cell of a row wider than the header and of a cell with a raw pipe", async () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 | EXTRACELL |\n| x | y | z | W4 |\n";
    const text = await render({ ...base, relatorioMarkdown: md });
    for (const t of ["EXTRACELL", "W4", "1", "2"]) expect(text, t).toContain(t);
  }, 30_000);

  it("prints the badge for a known aptitude and the raw value for an unknown one", async () => {
    expect(await render({ ...base, aptitude: "apt_with_caveats" })).toContain("APTO COM RESSALVAS");
    expect(await render({ ...base, aptitude: "valor_novo_da_api" })).toContain("valor_novo_da_api");
  }, 30_000);

  it("lets a paragraph taller than a page wrap under its heading", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const long = `${"frase longa de teste. ".repeat(360)}FIMPARAGRAFO`;
      const text = await render({ ...base, relatorioMarkdown: `# Titulo\n\n${long}\n\n## Outro\n\nfinal` });
      expect(text).toContain("FIMPARAGRAFO");
      expect(text).toContain("Titulo");
      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
      expect(logged).not.toContain("can't wrap");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 30_000);
});
