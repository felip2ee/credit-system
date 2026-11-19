import type { ReactNode } from "react";

import type { FullSection, SectionPart } from "@/types/consultation-view";

import { PdfTable, type PdfTableRow } from "../table";
import { asTable, formatPercentCell, hasNested, projectTable, type TableValue } from "./cells";
import { GenericPart, SectionTitle } from "./shared";

export const TOTALS_PART = "Totais";
const DETAIL_PREFIX = /^\s*—\s*/;
const SCR_COLUMNS = [
  { key: "descricao", label: "Descrição", type: "text" as const },
  { key: "valor", label: "Valor", type: "money" as const },
  { key: "percentual", label: "Percentual", type: "percent" as const, format: formatPercentCell },
];

// Tabela de itens do SCR (Descrição / Valor / Percentual); null se a parte tem outra forma.
const scrTable = (part: SectionPart): TableValue | null => {
  const table = asTable(part, ["descricao", "valor"]);
  return table && !hasNested(table) && table.rows.length > 0 ? table : null;
};

// Totais: linhas soltas. Grupo: a última linha é o total, que abre o grupo em negrito; itens um nível abaixo,
// detalhes (prefixo "— ") dois.
function toRows(table: TableValue, totals: boolean): { columns: ReturnType<typeof projectTable>["columns"]; rows: PdfTableRow[] } {
  const { columns, rows } = projectTable(table, SCR_COLUMNS);
  if (totals) return { columns, rows: rows.map((cells) => ({ cells })) };
  const first = 0; // `descricao` é sempre a primeira coluna pedida
  const item = (cells: string[]): PdfTableRow => ({
    cells: cells.map((cell, i) => (i === first ? cell.replace(DETAIL_PREFIX, "") : cell)),
    level: DETAIL_PREFIX.test(cells[first]) ? 2 : 1,
  });
  return { columns, rows: [{ cells: rows[rows.length - 1], kind: "subtotal", level: 0 }, ...rows.slice(0, -1).map(item)] };
}

// null quando nenhuma parte tem a forma do SCR: o motor genérico imprime a seção.
export function renderScr(section: FullSection): ReactNode | null {
  if (!section.parts.some((part) => scrTable(part))) return null;
  return (
    <>
      <SectionTitle title={section.title} />
      {section.parts.map((part, i) => {
        const table = scrTable(part);
        if (!table) return <GenericPart key={i} part={part} />;
        const { columns, rows } = toRows(table, part.title === TOTALS_PART);
        return <PdfTable key={i} title={part.title ?? undefined} columns={columns} rows={rows} />;
      })}
    </>
  );
}
