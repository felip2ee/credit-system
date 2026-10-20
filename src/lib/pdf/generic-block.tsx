import { View, Text } from "@react-pdf/renderer";

import type { GenericField, GenericValue } from "@/types/consultation-view";

import { Field, pdfStyles as s } from "./consultation-full-document";

function isInline(field: GenericField): boolean {
  return field.value.kind === "text";
}

// Mantém a ordem da tela: campos de texto vizinhos formam uma grade; um campo aninhado fecha a grade.
function PdfFields({ fields }: { fields: GenericField[] }) {
  const groups: (GenericField[] | GenericField)[] = [];
  for (const field of fields) {
    const last = groups[groups.length - 1];
    if (!isInline(field)) groups.push(field);
    else if (Array.isArray(last)) last.push(field);
    else groups.push([field]);
  }
  return (
    <>
      {groups.map((group) =>
        Array.isArray(group) ? (
          <View key={group[0].key} style={s.grid}>
            {group.map((f) => (
              <Field key={f.key} label={f.label} value={f.value.kind === "text" ? f.value.text : ""} />
            ))}
          </View>
        ) : (
          <View key={group.key}>
            <Text style={s.ssh}>{group.label}</Text>
            <PdfGenericValue value={group.value} />
          </View>
        ),
      )}
    </>
  );
}

const MAX_WEIGHT = 40;

// Largura de cada coluna proporcional ao maior texto (rótulo ou célula), normalizada para somar 1.
export function columnWidths(columns: { label: string }[], rows: string[][]): number[] {
  const weights = columns.map((column, i) =>
    Math.min(MAX_WEIGHT, Math.max(column.label.length, 3, ...rows.map((row) => (row[i] ?? "").length))),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

type TableValue = Extract<GenericValue, { kind: "table" }>;

// Larguras em % do contêiner (a tabela aninhada cabe no recuo); registros aninhados saem como sub-bloco sob a linha.
function PdfTable({ value }: { value: TableValue }) {
  const widths = columnWidths(value.columns, value.rows.map((row) => row.cells));
  return (
    <View style={{ marginTop: 2 }} minPresenceAhead={24}>
      {value.columns.length > 0 && (
        <View style={[s.tr, { backgroundColor: "#fff" }]} fixed>
          {value.columns.map((c, i) => (
            <Text key={c.key} style={[s.th, { width: `${widths[i] * 100}%` }]}>{c.label}</Text>
          ))}
        </View>
      )}
      {value.rows.map((row, ri) => (
        <View key={ri}>
          {value.columns.length > 0 && (
            <View style={s.tr} wrap={false}>
              {row.cells.map((cell, ci) => (
                <Text key={ci} style={[s.td, { width: `${widths[ci] * 100}%` }]}>{cell}</Text>
              ))}
            </View>
          )}
          {row.nested.map((n, ni) => (
            <View key={ni} style={{ marginLeft: 10, marginBottom: 3 }}>
              <Text style={s.ssh}>{n.label}</Text>
              <PdfGenericValue value={n.value} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// Renderiza qualquer valor genérico da deps; partes recolhidas na tela saem por inteiro no PDF.
export function PdfGenericValue({ value }: { value: GenericValue }) {
  switch (value.kind) {
    case "text":
      return <Text style={s.li}>{value.text || "—"}</Text>;
    case "fields":
      return <PdfFields fields={value.fields} />;
    case "table":
      return <PdfTable value={value} />;
    case "json":
      return (
        <View>
          {value.text.split("\n").map((line, i) => (
            <Text key={i} style={s.li}>{line}</Text>
          ))}
        </View>
      );
  }
}
