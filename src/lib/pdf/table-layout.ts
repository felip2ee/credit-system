// Regras puras do padrão de tabela (sem react-pdf): tipo, largura, alinhamento e quebra em blocos.
import { PDF_COLUMN_WIDTH, PDF_ROW_HEIGHT, PDF_TYPE } from "./theme";

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

// Largura estimada de um texto em Helvetica, em pt, por classe de caractere (em por caractere, com folga):
// maiúscula > minúscula > estreitos (i, l, j, pontuação); negrito é mais largo.
// shortcut: estimativa por classe, não medição da fonte; trocar por métricas AFM se a folga deixar de bastar.
const NARROW_CHARS = new Set(Array.from("iljtf.,:;'|!()[]/ -·…"));
const NARROW_EM = { regular: 0.27, bold: 0.3 };
const UPPER_EM = { regular: 0.7, bold: 0.76 };
const LOWER_EM = { regular: 0.53, bold: 0.58 };
const DIGIT_EM = 0.56;
const OTHER_EM = 0.6;
const MAX_CHAR_EM = 0.8;

export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  const weight = bold ? "bold" : "regular";
  let em = 0;
  for (const char of text) {
    if (NARROW_CHARS.has(char)) em += NARROW_EM[weight];
    else if (/\d/.test(char)) em += DIGIT_EM;
    else if (char !== char.toLowerCase()) em += UPPER_EM[weight];
    else if (char !== char.toUpperCase()) em += LOWER_EM[weight];
    else em += OTHER_EM;
  }
  return em * fontSize;
}

// Altura estimada de uma linha: o texto de cada célula quebra na largura da coluna; vale a célula mais alta.
const LINE_HEIGHT = 1.2;
const ROW_PADDING = 7.2;
const WRAP_SLACK = 1.1; // quebra por palavra desperdiça parte de cada linha
export function estimateRowHeight(cells: string[], widths: number[], fontSize: number = PDF_TYPE.table): number {
  let lines = 1;
  cells.forEach((cell, i) => {
    const room = Math.max((widths[i] ?? 0) - CELL_PADDING * 2, 1);
    let cellLines = 0;
    for (const paragraph of cell.split("\n")) {
      // Atalho: texto curto demais para passar de uma linha não precisa ser medido.
      const needed = paragraph.length * MAX_CHAR_EM * fontSize <= room ? 0 : estimateTextWidth(paragraph, fontSize) * WRAP_SLACK;
      cellLines += Math.max(1, Math.ceil(needed / room));
    }
    lines = Math.max(lines, cellLines);
  });
  return Math.max(PDF_ROW_HEIGHT, lines * fontSize * LINE_HEIGHT + ROW_PADDING);
}

// Valor monetário nunca quebra entre "R$" e o número: o espaço vira espaço sem quebra.
export function keepMoneyTogether(cell: string): string {
  return cell.replace(/^(-?R\$)\s/, "$1\u00A0");
}

// Largura que a maior célula precisa em uma linha só (colunas que não quebram: dinheiro, número, data).
export function valueMinWidth(cells: string[], fontSize: number = PDF_TYPE.table): number {
  const longest = Math.max(0, ...cells.map((cell) => estimateTextWidth(keepMoneyTogether(cell), fontSize)));
  return longest + CELL_PADDING * 2;
}

// Colunas fixas nunca ficam abaixo da palavra mais longa do cabeçalho nem do valor mais largo (`minWidths`);
// colunas de texto dividem o que sobra (também nunca abaixo da própria palavra). Se o total passa da largura útil,
// só o excesso acima desses mínimos encolhe; se nem os mínimos cabem, tudo escala na mesma proporção.
export function columnLayout(
  types: ColumnType[],
  contentWidth: number,
  labels: string[] = [],
  minWidths: number[] = [],
): { width: number; align: Align }[] {
  const floors = types.map((_, i) => headerMinWidth(labels[i] ?? ""));
  const mins = types.map((type, i) => (type === "text" ? floors[i] : Math.max(floors[i], minWidths[i] ?? 0)));
  const fixed = types.map((type, i) => (FIXED_WIDTH[type] === undefined ? 0 : Math.max(FIXED_WIDTH[type], mins[i])));
  const textCount = types.filter((type) => type === "text").length;
  const share = textCount > 0 ? (contentWidth - fixed.reduce((sum, width) => sum + width, 0)) / textCount : 0;
  const raw = types.map((type, i) => (type === "text" ? Math.max(floors[i], share) : fixed[i]));
  const total = raw.reduce((sum, width) => sum + width, 0);
  const minTotal = mins.reduce((sum, width) => sum + width, 0);
  const widths =
    total > contentWidth && minTotal < contentWidth && total > minTotal
      ? raw.map((width, i) => mins[i] + (width - mins[i]) * ((contentWidth - minTotal) / (total - minTotal)))
      : raw.map((width) => width * (total > 0 ? contentWidth / total : 1));
  return types.map((type, i) => ({ width: widths[i], align: alignOf(type) }));
}

// Blocos de linhas. Uma linha "de abertura" (título de grupo) nunca fica sozinha no fim de um bloco.
// Uma linha "solo" (conteúdo aninhado ou muito alta) forma o próprio bloco: a quebra de página cai entre linhas.
export function chunkRows<T>(
  rows: T[],
  firstChunk: number,
  nextChunk: number,
  isLead: (row: T) => boolean = () => false,
  isSolo: (row: T) => boolean = () => false,
): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  while (start < rows.length) {
    if (isSolo(rows[start])) {
      chunks.push([rows[start]]);
      start += 1;
      continue;
    }
    let end = Math.min(rows.length, start + (chunks.length === 0 ? firstChunk : nextChunk));
    const soloAt = rows.slice(start + 1, end).findIndex(isSolo);
    if (soloAt >= 0) end = start + 1 + soloAt;
    // Título de grupo antes de uma linha solo leva essa linha junto, para não ficar sozinho.
    if (end - start === 1 && isLead(rows[start]) && end < rows.length) end += 1;
    while (end < rows.length && end - start > 1 && isLead(rows[end - 1])) end--;
    chunks.push(rows.slice(start, end));
    start = end;
  }
  return chunks;
}
