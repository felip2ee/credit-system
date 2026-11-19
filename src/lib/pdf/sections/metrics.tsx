import type { ReactNode } from "react";

import type { GenericValue, SectionPart } from "@/types/consultation-view";

import { PdfTable } from "../table";
import { asTable, formatPercentCell, hasNested, projectTable, signedCell } from "./cells";
import { SectionTitle } from "./shared";

const METRIC_COLUMNS = [
  { key: "metrica", label: "Métrica", type: "text" as const },
  { key: "descricao", label: "Valor apurado", type: "text" as const },
  { key: "pontuacao", label: "Pontos", type: "number" as const, format: signedCell },
  { key: "impacto", label: "Impacto", type: "percent" as const, format: formatPercentCell },
  { key: "percentualMetrica", label: "% métrica", type: "percent" as const, format: formatPercentCell },
];

// Tabela de métricas no padrão. null: o motor genérico imprime a parte.
export function renderMetrics(part: SectionPart | undefined): ReactNode | null {
  const table = asTable(part, ["metrica"]);
  if (!part?.title || !table || hasNested(table)) return null;
  const { columns, rows } = projectTable(table, METRIC_COLUMNS);
  return (
    <>
      <SectionTitle title={part.title} />
      <PdfTable columns={columns} rows={rows.map((cells) => ({ cells }))} />
    </>
  );
}

// Mesmas colunas da API (impacto e percentualMetrica), mesmo formato: as tabelas de métricas aninhadas, que saem
// pelo motor genérico, não contradizem as curadas. Só mexe em tabela que traz a chave `metrica`.
const PERCENT_KEYS = ["impacto", "percentualMetrica"];

export function formatMetricPercents(value: GenericValue): GenericValue {
  if (value.kind === "fields") return { ...value, fields: value.fields.map((field) => ({ ...field, value: formatMetricPercents(field.value) })) };
  if (value.kind !== "table") return value;
  const isMetrics = value.columns.some((column) => column.key === "metrica");
  return {
    ...value,
    rows: value.rows.map((row) => ({
      cells: isMetrics
        ? row.cells.map((cell, i) => (PERCENT_KEYS.includes(value.columns[i]?.key ?? "") ? formatPercentCell(cell) : cell))
        : row.cells,
      nested: row.nested.map((n) => ({ ...n, value: formatMetricPercents(n.value) })),
    })),
  };
}
