import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";

import type { GenericValue, SectionPart } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PdfGenericValue } from "../generic-block";
import { PdfTable, type PdfTableRow } from "../table";
import { PDF_COLORS, PDF_TYPE } from "../theme";
import { asTable, cellOf, formatPercentCell, hasNested, projectTable, signedCell, type TableValue } from "./cells";
import { SectionTitle } from "./shared";

export const PARECER_PART = "Parecer";
export const RESULT_PART = "Resultado do parecer";
const RULES_INDENT = 12;
const RULE_COLUMNS = [
  { key: "descricao", label: "Regra", type: "text" as const },
  { key: "resultado", label: "Resultado", type: "short" as const },
  { key: "pontuacao", label: "Pontos", type: "number" as const, format: signedCell },
  { key: "obrigatorio", label: "Obrig.", type: "bool" as const },
  { key: "atendido", label: "Atend.", type: "bool" as const },
];
const YES = "Sim";

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", marginTop: 10, marginBottom: 3 },
  name: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, marginRight: 8 },
  note: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted, flex: 1 },
  label: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  status: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.table },
});

// Regras do grupo: tabela de regras (com `atendido` e `obrigatorio`) ou null.
const rulesTable = (value: GenericValue): TableValue | null =>
  value.kind === "table" && !hasNested(value) && value.columns.some((c) => c.key === "atendido") && value.columns.some((c) => c.key === "descricao")
    ? value
    : null;

function mandatoryCount(rules: TableValue | null): { met: number; total: number } {
  if (!rules) return { met: 0, total: 0 };
  const mandatory = rules.rows.map((_, r) => r).filter((r) => cellOf(rules, r, "obrigatorio") === YES);
  return { total: mandatory.length, met: mandatory.filter((r) => cellOf(rules, r, "atendido") === YES).length };
}

const hasValue = (cell: string): boolean => cell !== "" && cell !== "—";

// Cada percentual sai sempre que tem valor: o obtido sozinho, o esperado sozinho ("esperado X") ou os dois ("X de Y").
function percentNote(percent: string, expected: string): string {
  if (hasValue(percent)) return hasValue(expected) ? `${formatPercentCell(percent)} de ${formatPercentCell(expected)}` : formatPercentCell(percent);
  return hasValue(expected) ? `esperado ${formatPercentCell(expected)}` : "";
}

function GroupHead({ table, row, met, total }: { table: TableValue; row: number; met: number; total: number }) {
  const status = cellOf(table, row, "atendido");
  const known = status === YES || status === "Não";
  const color = status === YES ? PDF_COLORS.positive : PDF_COLORS.negative;
  const extras = table.columns
    .filter((c) => !["nome", "atendido", "percentual", "percentualEsperado"].includes(c.key))
    .map((c) => `${c.label}: ${cellOf(table, row, c.key)}`);
  const percent = cellOf(table, row, "percentual");
  const expected = cellOf(table, row, "percentualEsperado");
  const note = [
    total > 0 ? `${met}/${total} regras obrigatórias` : "",
    percentNote(percent, expected),
    ...extras,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={st.head}>
      <Text style={st.name}>{cellOf(table, row, "nome")}</Text>
      <Text style={st.note}>{note}</Text>
      {known ? <View style={[st.dot, { backgroundColor: color }]} /> : null}
      <Text style={[st.status, { color: known ? color : PDF_COLORS.muted }]}>{known ? (status === YES ? "Atendido" : "Não atendido") : status}</Text>
    </View>
  );
}

function GroupRules({ rules }: { rules: TableValue }) {
  const { columns, rows } = projectTable(rules, RULE_COLUMNS);
  return <PdfTable columns={columns} rows={rows.map((cells) => ({ cells }))} indent={RULES_INDENT} />;
}

// Um bloco só: um cabeçalho, cada grupo como linha discreta e suas regras abaixo, na mesma grade de colunas.
// Grupo sem tabela de regras (ou com colunas diferentes das do primeiro) leva o conteúdo sob a própria linha.
export function renderRules(title: string, parecer: SectionPart | undefined, result: SectionPart | undefined): ReactNode | null {
  const table = asTable(result, ["nome", "atendido"]);
  if (!table) return null;
  const groups = table.rows.map((row) => ({ row, rules: row.nested.length === 1 ? rulesTable(row.nested[0].value) : null }));
  const counts = groups.map((g) => mandatoryCount(g.rules));
  const total = counts.reduce((sum, c) => sum + c.total, 0);
  const met = counts.reduce((sum, c) => sum + c.met, 0);
  const heading = total > 0 ? `${title} · ${met}/${total} regras obrigatórias satisfeitas` : title;
  const projected = groups.map((g) => (g.rules ? projectTable(g.rules, RULE_COLUMNS) : null));
  const reference = projected.find((p) => p !== null) ?? null;
  const shape = (p: NonNullable<typeof reference>) => p.columns.map((c) => c.label).join("|");
  const tableRows: PdfTableRow[] = groups.flatMap((group, i) => {
    const head = <GroupHead table={table} row={i} met={counts[i].met} total={counts[i].total} />;
    const mine = projected[i];
    if (group.rules && mine && reference && shape(mine) === shape(reference)) {
      return [{ cells: [], heading: head }, ...mine.rows.map((cells): PdfTableRow => ({ cells, level: 1 }))];
    }
    const body = group.rules ? (
      <GroupRules rules={group.rules} />
    ) : (
      group.row.nested.map((n, ni) => (
        <View key={ni} style={{ marginLeft: RULES_INDENT }}>
          <Text style={st.label}>{n.label}</Text>
          <PdfGenericValue value={n.value} />
        </View>
      ))
    );
    return [{ cells: [], heading: head, extra: body }];
  });
  return (
    <>
      <SectionTitle title={heading} reserve={150} />
      {parecer ? <PdfGenericValue value={parecer.value} /> : null}
      <PdfTable columns={reference?.columns ?? []} rows={tableRows} />
    </>
  );
}
