import { StyleSheet, Text, View } from "@react-pdf/renderer";

import type { GenericField, GenericValue } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "./fonts";
import { PdfFields, PdfTable } from "./table";
import { PDF_COLORS, PDF_PAGE, PDF_TYPE } from "./theme";

const NESTED_INDENT = 10;

const st = StyleSheet.create({
  label: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.table, color: PDF_COLORS.ink, marginTop: 4, marginBottom: 2 },
  line: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, marginBottom: 2, lineHeight: 1.3 },
});

function isInline(field: GenericField): boolean {
  return field.value.kind === "text";
}

// Mantém a ordem da tela: campos de texto vizinhos formam uma grade; um campo aninhado fecha a grade.
function GenericFields({ fields, indent }: { fields: GenericField[]; indent: number }) {
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
          <PdfFields
            key={group[0].key}
            fields={group.map((f) => ({ label: f.label, value: f.value.kind === "text" ? f.value.text : "" }))}
          />
        ) : (
          <View key={group.key}>
            <Text style={st.label}>{group.label}</Text>
            <GenericValueAt value={group.value} indent={indent} />
          </View>
        ),
      )}
    </>
  );
}

type TableValue = Extract<GenericValue, { kind: "table" }>;

// Registros aninhados saem como sub-bloco recuado sob a linha; o recuo cresce a cada nível e a tabela encolhe com ele.
function GenericTable({ value, indent }: { value: TableValue; indent: number }) {
  const nestedIndent = indent + NESTED_INDENT;
  const rows = value.rows.map((row) => ({
    cells: row.cells,
    extra:
      row.nested.length > 0 ? (
        <View style={{ marginLeft: NESTED_INDENT, marginBottom: 3 }}>
          {row.nested.map((n, ni) => (
            <View key={ni}>
              <Text style={st.label}>{n.label}</Text>
              <GenericValueAt value={n.value} indent={nestedIndent} />
            </View>
          ))}
        </View>
      ) : undefined,
  }));
  return <PdfTable columns={value.columns.map((c) => ({ label: c.label }))} rows={rows} indent={indent} />;
}

function GenericValueAt({ value, indent }: { value: GenericValue; indent: number }) {
  switch (value.kind) {
    case "text":
      return <Text style={st.line}>{value.text || "—"}</Text>;
    case "fields":
      return <GenericFields fields={value.fields} indent={indent} />;
    case "table":
      return <GenericTable value={value} indent={indent} />;
    case "json":
      return (
        <View style={{ marginLeft: indent, maxWidth: PDF_PAGE.contentWidth - indent }}>
          {value.text.split("\n").map((line, i) => (
            <Text key={i} style={st.line}>{line}</Text>
          ))}
        </View>
      );
  }
}

// Renderiza qualquer valor genérico da deps; partes recolhidas na tela saem por inteiro no PDF.
export function PdfGenericValue({ value }: { value: GenericValue }) {
  return <GenericValueAt value={value} indent={0} />;
}
