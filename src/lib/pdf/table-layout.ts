// Regras puras do padrão de tabela (sem react-pdf): tipo, largura, alinhamento e quebra em blocos.
import { PDF_COLUMN_WIDTH, PDF_TYPE } from "./theme";

export type ColumnType = "text" | "short" | "money" | "percent" | "number" | "date" | "bool";

const EMPTY_CELL = /^(—|-|)$/;
const MAX_NUMBER_CHARS = 9; // acima disso (CPF, protocolo) a coluna de 56 pt não comporta o valor
const MAX_SHORT_CHARS = 12;
// Largura média de uma letra maiúscula em negrito, em em: estimativa (medida no render, ~0,62) com folga.
const HEADER_CHAR_EM = 0.68;
export const CELL_PADDING = 3;
const SHORT_LABELS = /^(operadora|tipo|resultado|uf|situação|status)$/i;

const TESTS: [ColumnType, (cell: string) => boolean][] = [
  ["money", (c) => /^-?R\$\s?/.test(c)],
  ["percent", (c) => /%$/.test(c)],
  ["number", (c) => c.length <= MAX_NUMBER_CHARS && /^[+-]?\d+([.,]\d+)*$/.test(c)],
  ["date", (c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)],
  ["bool", (c) => c === "Sim" || c === "Não"],
];

export function inferColumnType(label: string, cells: string[]): ColumnType {
  const filled = cells.filter((cell) => !EMPTY_CELL.test(cell.trim()));
  if (filled.length === 0) return "text";
  const found = TESTS.find(([, test]) => filled.every((cell) => test(cell.trim())));
  if (found) return found[0];
  if (SHORT_LABELS.test(label.trim()) && filled.every((cell) => cell.length <= MAX_SHORT_CHARS)) return "short";
  return "text";
}

export function dropEmptyColumns<T extends { label: string }>(
  columns: T[],
  rows: string[][],
): { columns: T[]; rows: string[][] } {
  const keep = columns.map((_, i) => rows.some((row) => !EMPTY_CELL.test((row[i] ?? "").trim())));
  return {
    columns: columns.filter((_, i) => keep[i]),
    rows: rows.map((row) => columns.flatMap((_, i) => (keep[i] ? [row[i] ?? ""] : []))),
  };
}

const FIXED_WIDTH: Partial<Record<ColumnType, number>> = {
  money: PDF_COLUMN_WIDTH.money,
  percent: PDF_COLUMN_WIDTH.percent,
  number: PDF_COLUMN_WIDTH.number,
  date: PDF_COLUMN_WIDTH.date,
  bool: PDF_COLUMN_WIDTH.bool,
  short: PDF_COLUMN_WIDTH.short,
};

type Align = "left" | "right" | "center";

function alignOf(type: ColumnType): Align {
  if (type === "money" || type === "percent" || type === "number") return "right";
  return type === "bool" ? "center" : "left";
}

// Largura mínima de uma coluna: a maior palavra do cabeçalho (o cabeçalho quebra entre palavras, uma palavra nunca estoura).
export function headerMinWidth(label: string): number {
  const longest = Math.max(0, ...label.split(/\s+/).map((word) => word.length));
  return longest * HEADER_CHAR_EM * PDF_TYPE.tableHeader + CELL_PADDING * 2;
}

// Colunas fixas nunca ficam abaixo da palavra mais longa do cabeçalho; colunas de texto dividem o que sobra
// (também nunca abaixo da própria palavra). Se o total ainda difere da largura útil, tudo escala na mesma proporção.
export function columnLayout(
  types: ColumnType[],
  contentWidth: number,
  labels: string[] = [],
): { width: number; align: Align }[] {
  const floors = types.map((_, i) => headerMinWidth(labels[i] ?? ""));
  const fixed = types.map((type, i) => (FIXED_WIDTH[type] === undefined ? 0 : Math.max(FIXED_WIDTH[type], floors[i])));
  const textCount = types.filter((type) => type === "text").length;
  const share = textCount > 0 ? (contentWidth - fixed.reduce((sum, width) => sum + width, 0)) / textCount : 0;
  const raw = types.map((type, i) => (type === "text" ? Math.max(floors[i], share) : fixed[i]));
  const total = raw.reduce((sum, width) => sum + width, 0);
  const scale = total > 0 ? contentWidth / total : 1;
  return types.map((type, i) => ({ width: raw[i] * scale, align: alignOf(type) }));
}

// Blocos de linhas. Uma linha "de abertura" (título de grupo) nunca fica sozinha no fim de um bloco.
export function chunkRows<T>(rows: T[], firstChunk: number, nextChunk: number, isLead: (row: T) => boolean = () => false): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  while (start < rows.length) {
    let end = Math.min(rows.length, start + (chunks.length === 0 ? firstChunk : nextChunk));
    while (end < rows.length && end - start > 1 && isLead(rows[end - 1])) end--;
    chunks.push(rows.slice(start, end));
    start = end;
  }
  return chunks;
}
