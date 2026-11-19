import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";

import type { FullSection } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PdfFields } from "../table";
import { PDF_COLORS } from "../theme";
import { asTable, cellOf, fieldText, findPart, isBlankText } from "./cells";
import { SectionTitle } from "./shared";

export const CLASSIFICATION_PART = "Classificação";
export const ALL_CLASSIFICATIONS_PART = "Todas as classificações";
const DEFAULT_SCALE = ["E", "D", "C", "B", "BB", "BBB", "A", "AA", "AAA"];

const st = StyleSheet.create({
  step: { flex: 1, alignItems: "center" },
  bar: { alignSelf: "stretch", height: 5, borderRadius: 3 },
});

function ClassScale({ scale, current }: { scale: string[]; current: string }) {
  return (
    <View wrap={false} style={{ flexDirection: "row", marginBottom: 10 }}>
      {scale.map((name, i) => {
        const active = name === current;
        return (
          <View key={name} style={[st.step, { paddingRight: i < scale.length - 1 ? 3 : 0 }]}>
            <View style={[st.bar, { backgroundColor: active ? PDF_COLORS.green : PDF_COLORS.ruleSoft }]} />
            <Text
              style={{
                fontFamily: active ? PDF_FONT_FAMILY_BOLD : PDF_FONT_FAMILY,
                fontSize: active ? 11 : 9,
                color: active ? PDF_COLORS.green : PDF_COLORS.muted,
                marginTop: 7,
              }}
            >
              {name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// Trilha com a classificação atual e os demais campos da parte em grade. null: o motor genérico imprime a parte.
export function renderClassification(section: FullSection): ReactNode | null {
  const part = findPart(section, CLASSIFICATION_PART);
  const current = fieldText(part, "classificacao");
  if (isBlankText(current) || part?.value.kind !== "fields") return null;
  if (part.value.fields.some((field) => field.value.kind !== "text")) return null;
  const all = asTable(findPart(section, ALL_CLASSIFICATIONS_PART), ["nome"]);
  const names = all ? all.rows.map((_, r) => cellOf(all, r, "nome")) : DEFAULT_SCALE;
  if (!names.includes(current)) return null;
  const rest = part.value.fields.filter((field) => field.key !== "classificacao");
  return (
    <>
      <SectionTitle title={CLASSIFICATION_PART} reserve={90} />
      <ClassScale scale={names} current={current} />
      <PdfFields fields={rest.map((field) => ({ label: field.label, value: field.value.kind === "text" ? field.value.text : "" }))} />
    </>
  );
}
