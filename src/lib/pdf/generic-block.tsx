import { View, Text } from "@react-pdf/renderer";

import type { GenericField, GenericValue } from "@/types/consultation-view";

import { Field, Table, pdfStyles as s } from "./consultation-full-document";

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

// Renderiza qualquer valor genérico da deps; partes recolhidas na tela saem por inteiro no PDF.
export function PdfGenericValue({ value }: { value: GenericValue }) {
  switch (value.kind) {
    case "text":
      return <Text style={s.li}>{value.text || "—"}</Text>;
    case "fields":
      return <PdfFields fields={value.fields} />;
    case "table": {
      return (
        <Table
          cols={value.columns.map((c) => c.label)}
          widths={columnWidths(value.columns, value.rows)}
          rows={value.rows}
        />
      );
    }
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
