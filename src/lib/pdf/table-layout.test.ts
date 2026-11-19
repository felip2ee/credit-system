import { describe, expect, it } from "vitest";

import { PDF_COLUMN_WIDTH, PDF_PAGE } from "./theme";
import { CELL_PADDING, chunkRows, columnLayout, dropEmptyColumns, headerMinWidth, inferColumnType } from "./table-layout";

describe("inferColumnType", () => {
  it("detects money, percent, number, date and yes/no columns", () => {
    expect(inferColumnType("Valor", ["R$ 1,00", "R$ 1.234,56"])).toBe("money");
    expect(inferColumnType("Perc", ["12,34%", "0,50%"])).toBe("percent");
    expect(inferColumnType("Qtd", ["1", "2,5", "30"])).toBe("number");
    expect(inferColumnType("Data", ["01/02/2026", "31/12/2025"])).toBe("date");
    expect(inferColumnType("Ativo", ["Sim", "Não"])).toBe("bool");
  });
  it("falls back to text for mixed cells and long digit strings", () => {
    expect(inferColumnType("Valor", ["R$ 1,00", "abc"])).toBe("text");
    expect(inferColumnType("Doc", ["12345678901"])).toBe("text");
  });
  it("keeps text when every cell is empty", () => {
    expect(inferColumnType("Valor", ["—", ""])).toBe("text");
  });
  it("uses short for known short labels with short cells", () => {
    expect(inferColumnType("Operadora", ["Claro", "TIM"])).toBe("short");
    expect(inferColumnType("UF", ["SP"])).toBe("short");
    expect(inferColumnType("Tipo", ["a".repeat(13)])).toBe("text");
  });
});

describe("dropEmptyColumns", () => {
  it("removes columns whose cells are all empty or a dash", () => {
    const out = dropEmptyColumns([{ label: "A" }, { label: "B" }, { label: "C" }], [["x", "", "—"], ["y", "", "—"]]);
    expect(out.columns.map((c) => c.label)).toEqual(["A"]);
    expect(out.rows).toEqual([["x"], ["y"]]);
  });
  it("keeps a column with a single value", () => {
    const out = dropEmptyColumns([{ label: "A" }, { label: "B" }], [["x", ""], ["y", "v"]]);
    expect(out.columns).toHaveLength(2);
    expect(out.rows).toEqual([["x", ""], ["y", "v"]]);
  });
});

describe("columnLayout", () => {
  const sum = (l: { width: number }[]) => l.reduce((a, c) => a + c.width, 0);
  it("uses the fixed widths, aligns by type and shares the rest between text columns", () => {
    const l = columnLayout(["text", "money", "percent", "number", "bool", "text"], PDF_PAGE.contentWidth);
    expect(sum(l)).toBeCloseTo(PDF_PAGE.contentWidth, 0);
    expect(l[1]).toEqual({ width: PDF_COLUMN_WIDTH.money, align: "right" });
    expect(l[2]).toEqual({ width: PDF_COLUMN_WIDTH.percent, align: "right" });
    expect(l[3]).toEqual({ width: PDF_COLUMN_WIDTH.number, align: "right" });
    expect(l[4]).toEqual({ width: PDF_COLUMN_WIDTH.bool, align: "center" });
    expect(l[0].width).toBeCloseTo(l[5].width);
    expect(l[0].align).toBe("left");
  });
  it("scales down when the fixed widths exceed the content width", () => {
    const l = columnLayout(["money", "money", "money", "percent", "percent", "text"], 300);
    expect(sum(l)).toBeCloseTo(300, 0);
    expect(l[0].width).toBeLessThan(PDF_COLUMN_WIDTH.money);
  });
  it("still sums to the content width with no text column", () => {
    expect(sum(columnLayout(["money", "date"], PDF_PAGE.contentWidth))).toBeCloseTo(PDF_PAGE.contentWidth, 0);
  });
});

describe("columnLayout with header labels", () => {
  const sum = (l: { width: number }[]) => l.reduce((a, c) => a + c.width, 0);
  const labels = ["Nome", "Validade", "Limite máximo", "Limite mínimo", "Limite exigido", "Pontuação atingida", "Multiplicador de arranque"];
  const types = ["text", "number", "money", "money", "money", "number", "number"] as const;

  it("gives a numeric column at least its longest header word", () => {
    const l = columnLayout([...types], PDF_PAGE.contentWidth, labels);
    expect(sum(l)).toBeCloseTo(PDF_PAGE.contentWidth, 0);
    expect(l[6].width).toBeGreaterThanOrEqual(headerMinWidth("MULTIPLICADOR"));
    expect(l[5].width).toBeGreaterThanOrEqual(headerMinWidth("PONTUAÇÃO"));
    expect(l[6].width).toBeGreaterThan(PDF_COLUMN_WIDTH.number);
  });
  it("takes the extra width from the text column", () => {
    const plain = columnLayout([...types], PDF_PAGE.contentWidth);
    const withLabels = columnLayout([...types], PDF_PAGE.contentWidth, labels);
    expect(withLabels[0].width).toBeLessThan(plain[0].width);
  });
  it("never lets a column fall below its header word while there is a text column to shrink", () => {
    const l = columnLayout(["text", "number"], 200, ["Nome", "Multiplicador"]);
    expect(l[1].width).toBeGreaterThanOrEqual(headerMinWidth("Multiplicador"));
    expect(sum(l)).toBeCloseTo(200, 0);
  });
  it("scales everything to the content width when nothing can shrink", () => {
    const l = columnLayout(["money", "money", "number"], 180, ["Limite máximo", "Limite mínimo", "Multiplicador de arranque"]);
    expect(sum(l)).toBeCloseTo(180, 0);
  });
  it("estimates the width of the longest word plus the cell padding", () => {
    expect(headerMinWidth("a bb cccc")).toBeCloseTo(headerMinWidth("cccc"));
    expect(headerMinWidth("")).toBe(CELL_PADDING * 2);
  });
});

describe("chunkRows", () => {
  it("never ends a chunk on a lead row", () => {
    const rows = ["a", "b", "c", "G", "d", "e"];
    const chunks = chunkRows(rows, 4, 4, (r) => r === "G");
    expect(chunks).toEqual([["a", "b", "c"], ["G", "d", "e"]]);
    expect(chunks.flat()).toEqual(rows);
  });
  it("returns no chunk for no rows and one chunk when the rows fit the first", () => {
    expect(chunkRows([], 10, 12)).toEqual([]);
    expect(chunkRows([1, 2, 3, 4, 5], 10, 12)).toEqual([[1, 2, 3, 4, 5]]);
  });
  it("uses the first size, then the next size, and loses no row", () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkRows(rows, 10, 12);
    expect(chunks.map((c) => c.length)).toEqual([10, 12, 3]);
    expect(chunks.flat()).toEqual(rows);
  });
});
