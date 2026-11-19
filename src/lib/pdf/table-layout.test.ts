import { describe, expect, it } from "vitest";

import { PDF_COLUMN_WIDTH, PDF_PAGE } from "./theme";
import {
  CELL_PADDING,
  chunkRows,
  columnLayout,
  dropEmptyColumns,
  estimateRowHeight,
  estimateTextWidth,
  headerMinWidth,
  inferColumnType,
  keepMoneyTogether,
  valueMinWidth,
} from "./table-layout";

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

describe("estimateTextWidth", () => {
  it("counts uppercase wider than lowercase, and bold wider than regular", () => {
    expect(estimateTextWidth("AAAAAAAAAA", 10, true)).toBeGreaterThan(estimateTextWidth("aaaaaaaaaa", 10, true));
    expect(estimateTextWidth("aaaaaaaaaa", 10, true)).toBeGreaterThan(estimateTextWidth("aaaaaaaaaa", 10));
    expect(estimateTextWidth("iiiiiiiiii", 10)).toBeLessThan(estimateTextWidth("0000000000", 10));
    expect(estimateTextWidth("", 10)).toBe(0);
  });
});

describe("estimateRowHeight", () => {
  const widths = [400, 60];
  it("keeps a normal row at the standard height", () => {
    expect(estimateRowHeight(["Item", "Sim"], widths)).toBeLessThan(30);
  });
  it("grows with the text length of a cell", () => {
    const usable = PDF_PAGE.height - PDF_PAGE.paddingTop - PDF_PAGE.paddingBottom;
    expect(estimateRowHeight(["palavra ".repeat(250), "x"], widths)).toBeLessThan(usable / 2);
    expect(estimateRowHeight(["palavra ".repeat(1500), "x"], widths)).toBeGreaterThan(usable);
  });
  it("counts explicit line breaks", () => {
    expect(estimateRowHeight(["a\nb\nc\nd", "x"], widths)).toBeGreaterThan(estimateRowHeight(["a", "x"], widths) + 20);
  });
});

describe("keepMoneyTogether", () => {
  it("binds the currency sign to the number with a no-break space", () => {
    expect(keepMoneyTogether("R$ 1.234,56")).toBe("R$\u00A01.234,56");
    expect(keepMoneyTogether("-R$ 5,00")).toBe("-R$\u00A05,00");
  });
  it("leaves other text alone", () => {
    expect(keepMoneyTogether("abc def")).toBe("abc def");
    expect(keepMoneyTogether("—")).toBe("—");
  });
});

describe("columnLayout with minimum widths", () => {
  const sum = (l: { width: number }[]) => l.reduce((a, c) => a + c.width, 0);
  it("shrinks fixed columns only down to their value width when that fits", () => {
    const types = ["money", "money", "money", "money", "money", "money", "text"] as const;
    const mins = [70, 70, 70, 70, 70, 70, 0];
    const l = columnLayout([...types], PDF_PAGE.contentWidth, [], mins);
    expect(sum(l)).toBeCloseTo(PDF_PAGE.contentWidth, 0);
    for (let i = 0; i < 6; i += 1) expect(l[i].width).toBeGreaterThanOrEqual(70 - 0.001);
  });
  it("keeps the proportional scaling when the minimums do not fit", () => {
    const types = Array.from({ length: 8 }, () => "money" as const);
    const l = columnLayout([...types], PDF_PAGE.contentWidth, [], types.map(() => 80));
    expect(sum(l)).toBeCloseTo(PDF_PAGE.contentWidth, 0);
  });
});

describe("valueMinWidth", () => {
  it("is the width of the longest cell plus the padding", () => {
    expect(valueMinWidth(["R$ 1,00", "R$ 1.234.567,00"], 9)).toBeGreaterThan(valueMinWidth(["R$ 1,00"], 9));
    expect(valueMinWidth([], 9)).toBe(CELL_PADDING * 2);
  });
});

describe("chunkRows solo rows", () => {
  it("puts a solo row alone in its chunk and loses no row", () => {
    const rows = ["a", "b", "S", "c", "d"];
    const chunks = chunkRows(rows, 4, 4, () => false, (r) => r === "S");
    expect(chunks).toEqual([["a", "b"], ["S"], ["c", "d"]]);
    expect(chunks.flat()).toEqual(rows);
  });
});
