import { View, Text } from "@react-pdf/renderer";

import type { GenericField, GenericValue } from "@/types/consultation-view";

import { Field, Table, pdfStyles as s } from "./consultation-full-document";

function isInline(field: GenericField): boolean {
  return field.value.kind === "text";
}

function PdfFields({ fields }: { fields: GenericField[] }) {
  const inline = fields.filter(isInline);
  const nested = fields.filter((f) => !isInline(f));
  return (
    <>
      {inline.length > 0 && (
        <View style={s.grid}>
          {inline.map((f) => (
            <Field key={f.key} label={f.label} value={f.value.kind === "text" ? f.value.text : ""} />
          ))}
        </View>
      )}
      {nested.map((f) => (
        <View key={f.key}>
          <Text style={s.ssh}>{f.label}</Text>
          <PdfGenericValue value={f.value} />
        </View>
      ))}
    </>
  );
}

// Renderiza qualquer valor genérico da deps; partes recolhidas na tela saem por inteiro no PDF.
export function PdfGenericValue({ value }: { value: GenericValue }) {
  switch (value.kind) {
    case "text":
      return <Text style={s.li}>{value.text || "—"}</Text>;
    case "fields":
      return <PdfFields fields={value.fields} />;
    case "table": {
      const widths = value.columns.map(() => 1 / value.columns.length);
      return <Table cols={value.columns.map((c) => c.label)} widths={widths} rows={value.rows} />;
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
