import { StyleSheet, Text, View } from "@react-pdf/renderer";

import type { FullConsultationView } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PDF_COLORS, PDF_PAGE, PDF_TYPE } from "../theme";
import { asTable, cellOf, fieldText, findPart, isBlankText } from "./cells";
import { CLASSIFICATION_PART } from "./classification";
import { PARECER_PART } from "./rules";
import { TOTALS_PART } from "./scr";

export interface SummaryFigure {
  label: string;
  value: string;
  caption?: string;
  captionColor?: string;
  color?: string;
}

const EMPTY = "—";
const FIGURE_SHARE = [0.14, 0.16, 0.2, 0.25, 0.25];
const LONG_VALUE = 12;
const CAPTION_GAP = 3;

const st = StyleSheet.create({
  label: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted, marginBottom: 4 },
  caption: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, marginTop: CAPTION_GAP },
});

const orEmpty = (text: string | null): string => (isBlankText(text) ? EMPTY : text);

// Cinco indicadores da primeira página. Sem dado, o indicador mostra "—".
export function summaryFigures(full: FullConsultationView): SummaryFigure[] {
  const byId = (id: string) => full.sections.find((section) => section.id === id);
  const score = byId("score");
  const smart = byId("smart");
  const classification = smart ? findPart(smart, CLASSIFICATION_PART) : undefined;
  const approved = fieldText(smart ? findPart(smart, PARECER_PART) : undefined, "aprovado");
  const scr = byId("scr");
  const totals = scr ? asTable(findPart(scr, TOTALS_PART), ["descricao", "valor"]) : null;
  const creditRow = totals ? totals.rows.findIndex((_, r) => /^carteira de cr[eé]dito/i.test(cellOf(totals, r, "descricao"))) : -1;
  const risk = fieldText(score ? findPart(score, null) : undefined, "risco");
  const policy = fieldText(classification, "politica");
  const size = fieldText(classification, "porte");
  const ticket = fieldText(classification, "ticketMedio");
  return [
    {
      label: "Score",
      value: full.scoreValue === null ? EMPTY : String(full.scoreValue),
      caption: isBlankText(risk) ? undefined : `Risco ${risk}`,
      captionColor: PDF_COLORS.goldText,
    },
    { label: "Classificação", value: orEmpty(fieldText(classification, "classificacao")), caption: isBlankText(size) ? undefined : `Porte ${size}` },
    {
      label: "Parecer",
      value: approved === "Sim" ? "Aprovado" : approved === "Não" ? "Reprovado" : EMPTY,
      color: approved === "Sim" ? PDF_COLORS.positive : approved === "Não" ? PDF_COLORS.negative : undefined,
      caption: isBlankText(policy) ? undefined : policy,
    },
    {
      label: "Limite sugerido",
      value: orEmpty(fieldText(classification, "limiteSugerido")),
      caption: isBlankText(ticket) ? undefined : `Ticket médio ${ticket}`,
    },
    { label: "Total SCR", value: totals && creditRow >= 0 ? cellOf(totals, creditRow, "valor") : EMPTY },
  ];
}

export function Summary({ full }: { full: FullConsultationView }) {
  return (
    <View wrap={false} style={{ flexDirection: "row", marginTop: 18, marginBottom: 4 }}>
      {summaryFigures(full).map((figure, i) => (
        <View
          key={figure.label}
          style={{
            width: PDF_PAGE.contentWidth * FIGURE_SHARE[i],
            paddingLeft: i === 0 ? 0 : 12,
            borderLeftWidth: i === 0 ? 0 : 0.75,
            borderLeftColor: PDF_COLORS.ruleSoft,
          }}
        >
          <Text style={st.label}>{figure.label}</Text>
          <Text
            style={{
              fontFamily: PDF_FONT_FAMILY_BOLD,
              fontSize: figure.value.length > LONG_VALUE ? 15 : PDF_TYPE.figure,
              color: figure.value === EMPTY ? PDF_COLORS.muted : (figure.color ?? PDF_COLORS.ink),
            }}
          >
            {figure.value}
          </Text>
          {figure.caption ? <Text style={[st.caption, { color: figure.captionColor ?? PDF_COLORS.muted }]}>{figure.caption}</Text> : null}
        </View>
      ))}
    </View>
  );
}
