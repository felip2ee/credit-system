import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";

import type { FullSection } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PdfFields } from "../table";
import { PDF_COLORS, PDF_TYPE } from "../theme";
import type { CuratedContext } from "./cells";
import { GenericParts, SectionTitle } from "./shared";

// Faixas de risco: largura em % da trilha e intervalo de pontos.
const BANDS = [
  { label: "Muito alto", color: "#C8594F", width: 25, from: 0, to: 400 },
  { label: "Alto", color: "#E0875A", width: 22, from: 400, to: 600 },
  { label: "Médio", color: "#E8B04F", width: 22, from: 600, to: 800 },
  { label: "Baixo", color: "#A9C96B", width: 17, from: 800, to: 900 },
  { label: "Muito baixo", color: "#5FA777", width: 14, from: 900, to: 1000 },
];
const MARKER_RADIUS = 6;

const st = StyleSheet.create({
  caption: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted },
  text: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, lineHeight: 1.4, marginTop: 10, marginBottom: 6 },
});

// Posição do marcador, em % da trilha.
function markerPercent(score: number): number {
  let accumulated = 0;
  for (const band of BANDS) {
    if (score <= band.to) return accumulated + (Math.max(score - band.from, 0) / (band.to - band.from)) * band.width;
    accumulated += band.width;
  }
  return 100;
}

export function ScoreTrack({ score }: { score: number }) {
  return (
    <View wrap={false}>
      <View style={{ height: 14, justifyContent: "center" }}>
        <View style={{ flexDirection: "row", height: 6 }}>
          {BANDS.map((band, i) => (
            <View key={band.label} style={{ width: `${band.width}%`, paddingRight: i < BANDS.length - 1 ? 3 : 0 }}>
              <View style={{ flex: 1, backgroundColor: band.color, borderRadius: 3 }} />
            </View>
          ))}
        </View>
        <View
          style={{
            position: "absolute",
            left: `${markerPercent(score)}%`,
            top: 7 - MARKER_RADIUS,
            marginLeft: -MARKER_RADIUS,
            width: MARKER_RADIUS * 2,
            height: MARKER_RADIUS * 2,
            borderRadius: MARKER_RADIUS,
            backgroundColor: "#FFFFFF",
            borderWidth: 2,
            borderColor: PDF_COLORS.ink,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", marginTop: 6 }}>
        {BANDS.map((band) => {
          const active = score >= band.from && score <= band.to;
          return (
            <Text
              key={band.label}
              style={[st.caption, { width: `${band.width}%`, textAlign: "center" }, active ? { fontFamily: PDF_FONT_FAMILY_BOLD, color: PDF_COLORS.ink } : {}]}
            >
              {band.label}
            </Text>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
        <Text style={st.caption}>+ risco</Text>
        <View style={{ flex: 1, height: 0.75, backgroundColor: PDF_COLORS.ruleSoft, marginHorizontal: 8 }} />
        <Text style={st.caption}>- risco</Text>
      </View>
    </View>
  );
}

// Trilha e descrição; os demais campos da parte seguem em grade. Sem score numérico ou com campo que não é texto: genérico.
export function renderScore(section: FullSection, context: CuratedContext): ReactNode | null {
  const [main, ...others] = section.parts;
  if (context.scoreValue === null || main?.title !== null || main.value.kind !== "fields") return null;
  if (main.value.fields.some((field) => field.value.kind !== "text")) return null;
  const description = main.value.fields.find((field) => field.key === "descricao");
  const rest = main.value.fields.filter((field) => field.key !== "score" && field.key !== "descricao");
  return (
    <>
      <SectionTitle title={section.title} reserve={110} />
      <ScoreTrack score={context.scoreValue} />
      {description?.value.kind === "text" ? <Text style={st.text}>{description.value.text}</Text> : null}
      <PdfFields fields={rest.map((field) => ({ label: field.label, value: field.value.kind === "text" ? field.value.text : "" }))} />
      <GenericParts parts={others} />
    </>
  );
}
