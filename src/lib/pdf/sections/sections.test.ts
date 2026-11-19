import { describe, expect, it } from "vitest";

import pfFixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toFullConsultationView } from "@/lib/consultations/full-view";
import type { FullSection } from "@/types/consultation-view";
import { addressLine, formatPercentCell, projectTable, signedCell, type TableValue } from "./cells";
import { renderCuratedSection, summaryFigures } from "./index";
import { formatMetricPercents } from "./metrics";
import { confidentialLine, eyebrowText } from "./identity";

const table = (columns: string[], rows: string[][]): TableValue => ({
  kind: "table",
  columns: columns.map((key) => ({ key, label: key })),
  rows: rows.map((cells) => ({ cells, nested: [] })),
});

describe("formatPercentCell", () => {
  it.each([
    ["100 %", "100,00%"],
    ["10,22 %", "10,22%"],
    ["0,00%", "0,00%"],
    ["46,1", "46,10%"],
    ["97.13%", "97,13%"],
    ["-3", "-3,00%"],
  ])("formats %s as %s", (input, expected) => expect(formatPercentCell(input)).toBe(expected));
  it("keeps what is not a number", () => expect(formatPercentCell("—")).toBe("—"));
});

describe("formatMetricPercents", () => {
  it("formats impacto and percentualMetrica of nested metric tables, and only those", () => {
    const metrics = table(["impacto", "metrica", "pontuacao", "percentualMetrica"], [["46.15", "Score", "6", "25"]]);
    const outer: TableValue = { kind: "table", columns: [{ key: "data", label: "Data" }], rows: [{ cells: ["19/10"], nested: [{ label: "Positivas", value: metrics }] }] };
    const out = formatMetricPercents(outer) as TableValue;
    expect((out.rows[0].nested[0].value as TableValue).rows[0].cells).toEqual(["46,15%", "Score", "6", "25,00%"]);
    expect(out.rows[0].cells).toEqual(["19/10"]);
  });
  it("leaves a table without a metrica column untouched", () => {
    const t = table(["impacto"], [["3"]]);
    expect(formatMetricPercents(t)).toEqual(t);
  });
});

describe("signedCell", () => {
  it("adds a plus to positive points only", () => {
    expect(signedCell("6")).toBe("+6");
    expect(signedCell("0")).toBe("0");
    expect(signedCell("-21")).toBe("-21");
    expect(signedCell("—")).toBe("—");
  });
});

describe("projectTable", () => {
  it("orders the named columns and keeps the unnamed ones after them", () => {
    const t = table(["extra", "valor", "descricao"], [["x", "R$ 1,00", "Item"]]);
    const { columns, rows } = projectTable(t, [{ key: "descricao", label: "Descrição" }, { key: "valor", label: "Valor" }]);
    expect(columns.map((c) => c.label)).toEqual(["Descrição", "Valor", "extra"]);
    expect(rows).toEqual([["Item", "R$ 1,00", "x"]]);
  });
});

describe("addressLine", () => {
  it("joins the address on one line and keeps an unknown column", () => {
    const t = table(["uf", "cep", "bairro", "numero", "endereco", "municipio", "complemento", "referencia"], [
      ["MG", "38400000", "Centro", "10", "Rua A", "Uberlândia", "—", "Perto da praça"],
    ]);
    expect(addressLine(t, 0)).toBe("Rua A, 10 · Centro · Uberlândia/MG · CEP 38400-000 · referencia: Perto da praça");
  });
});

describe("header text", () => {
  it("hides a UUID user and shows a name", () => {
    const base = { consultante: "Rainha Cred" };
    expect(confidentialLine({ ...base, usuario: "3f2b8c1e-9d4a-4b7e-8a61-0c5d2e9f7a11" })).toBe("Confidencial para Rainha Cred");
    expect(confidentialLine({ ...base, usuario: "Ana" })).toBe("Confidencial para Rainha Cred · Usuário Ana");
  });
  it("builds the eyebrow from the document kind, role and product", () => {
    expect(eyebrowText("consulta", "Smart PF")).toBe("RELATÓRIO DE CONSULTA · Smart PF");
    expect(eyebrowText("dossie", "Smart PF", "Sócio")).toBe("DOSSIÊ · Sócio · Smart PF");
  });
});

describe("summaryFigures", () => {
  it("fills the five figures from the PF payload", () => {
    const full = toFullConsultationView(pfFixture);
    const figures = summaryFigures(full as NonNullable<typeof full>);
    expect(figures.map((f) => f.value.replace(/\u00a0/g, " "))).toEqual(["677", "E", "Aprovado", "R$ 0,00", "R$ 3.095,34"]);
  });
  it("prints a dash for each missing figure", () => {
    const full = { sections: [], generic: [], missing: [], meta: [], scoreValue: null };
    expect(summaryFigures(full).map((f) => f.value)).toEqual(["—", "—", "—", "—", "—"]);
  });
});

describe("renderCuratedSection", () => {
  const section = (id: string, parts: FullSection["parts"]): FullSection => ({ id: id as FullSection["id"], title: "T", sources: [], parts });
  it("returns null for an unknown section key", () => {
    expect(renderCuratedSection(section("novaChave", []), { scoreValue: null })).toBeNull();
  });
  it("returns null when a curated key has no shape it knows", () => {
    const text = { title: "X", value: { kind: "text" as const, text: "a" }, collapsed: false };
    expect(renderCuratedSection(section("scr", [text]), { scoreValue: null })).toBeNull();
    expect(renderCuratedSection(section("smart", [text]), { scoreValue: null })).toBeNull();
    expect(renderCuratedSection(section("contatos", [text]), { scoreValue: null })).toBeNull();
    expect(renderCuratedSection(section("score", [text]), { scoreValue: 500 })).toBeNull();
  });
});
