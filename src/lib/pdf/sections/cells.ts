// Leitura da visão completa e formatação de células. Funções puras, sem react-pdf.

import type { FullSection, GenericValue, SectionPart } from "@/types/consultation-view";

import type { ColumnType } from "../table-layout";

export type TableValue = Extract<GenericValue, { kind: "table" }>;

// O que um desenho de seção precisa saber além da própria seção.
export interface CuratedContext {
  scoreValue: number | null;
}

export const findPart = (section: FullSection, title: string | null): SectionPart | undefined =>
  section.parts.find((part) => part.title === title);

// Texto de um campo escalar da parte; null se a parte, o campo ou o texto não existe.
export function fieldText(part: SectionPart | undefined, key: string): string | null {
  if (part?.value.kind !== "fields") return null;
  const value = part.value.fields.find((field) => field.key === key)?.value;
  return value?.kind === "text" ? value.text : null;
}

export const isBlankText = (text: string | null): text is null => text === null || text.trim() === "" || text === "—";

// Tabela da parte que traz todas as chaves pedidas; null caso contrário.
export function asTable(part: SectionPart | undefined, keys: string[]): TableValue | null {
  if (part?.value.kind !== "table") return null;
  const present = part.value.columns.map((column) => column.key);
  return keys.every((key) => present.includes(key)) ? part.value : null;
}

export const hasNested = (table: TableValue): boolean => table.rows.some((row) => row.nested.length > 0);

export function cellOf(table: TableValue, row: number, key: string): string {
  const index = table.columns.findIndex((column) => column.key === key);
  return index < 0 ? "" : (table.rows[row].cells[index] ?? "");
}

const PERCENT_NUMBER = /^-?\d+(?:[.,]\d+)?$/;

// Percentual sempre com duas casas ("12,34%"). A API manda "100 %", "10,22", "97.13%": o que não é número fica como veio.
export function formatPercentCell(cell: string): string {
  const raw = cell.replace(/%/g, "").replace(/\s/g, "");
  if (!PERCENT_NUMBER.test(raw)) return cell;
  const value = Number(raw.replace(",", "."));
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

// Pontuação com sinal explícito: "6" vira "+6"; zero e negativos ficam como vieram.
export function signedCell(cell: string): string {
  const value = Number(cell.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? `+${cell}` : cell;
}

export interface ColumnSpec {
  key: string;
  label?: string;
  type?: ColumnType;
  format?: (cell: string) => string;
}

// Colunas pedidas, na ordem pedida; colunas que a tabela traz e o pedido não nomeia vão depois, como vieram.
export function projectTable(
  table: TableValue,
  specs: ColumnSpec[],
): { columns: { label: string; type?: ColumnType }[]; rows: string[][] } {
  const known = specs.filter((spec) => table.columns.some((column) => column.key === spec.key));
  const extra = table.columns.filter((column) => !specs.some((spec) => spec.key === column.key));
  const all: ColumnSpec[] = [...known, ...extra.map((column) => ({ key: column.key, label: column.label }))];
  return {
    columns: all.map((spec) => ({
      label: spec.label ?? table.columns.find((column) => column.key === spec.key)?.label ?? spec.key,
      type: spec.type,
    })),
    rows: table.rows.map((_, r) => all.map((spec) => (spec.format ?? ((cell: string) => cell))(cellOf(table, r, spec.key)))),
  };
}

const ADDRESS_KEYS = ["endereco", "numero", "complemento", "bairro", "cidade", "municipio", "uf", "cep"];
const cepFormat = (cep: string): string => cep.replace(/^(\d{5})(\d{3})$/, "$1-$2");

// Um endereço numa linha. Coluna fora da lista conhecida entra como "Rótulo: valor": nada se perde.
export function addressLine(table: TableValue, row: number): string {
  const get = (key: string): string => {
    const cell = cellOf(table, row, key);
    return cell === "—" ? "" : cell;
  };
  const city = [get("cidade") || get("municipio"), get("uf")].filter(Boolean).join("/");
  const street = [get("endereco"), get("numero")].filter(Boolean).join(", ");
  const cep = get("cep");
  const extras = table.columns
    .filter((column) => !ADDRESS_KEYS.includes(column.key) && get(column.key))
    .map((column) => `${column.label}: ${get(column.key)}`);
  return [street, get("complemento"), get("bairro"), city, cep ? `CEP ${cepFormat(cep)}` : "", ...extras]
    .filter(Boolean)
    .join(" · ");
}
