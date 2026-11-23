import { Line, Rect, Svg, Text, View } from "@react-pdf/renderer";

import { layoutMapaMental, type MapaNodeKind } from "@/lib/ai/mapa-mental-layout";
import type { MapaMental } from "@/types/ai";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "./fonts";
import { PDF_COLORS, PDF_PAGE } from "./theme";

const LINE_H = 11;
const BOX_PAD_X = 6;
const BOX_PAD_Y = 5;
const FONT = 9;
const META_FONT = 8;
// Altura útil da página menos o título da seção (a faixa 0 deve caber sob ele): acima disso a faixa é reduzida, nunca cortada.
const MAX_BAND_HEIGHT = PDF_PAGE.height - PDF_PAGE.paddingTop - PDF_PAGE.paddingBottom - 80;
// Largura média de um glifo em 8 pt (linha de prazo e dono).
const META_CHAR_W = 3.9;

const PRAZO_LABEL: Record<string, string> = {
  "30_dias": "30 dias",
  "60_dias": "60 dias",
  "90_dias": "90 dias",
  "180_dias": "180 dias",
  continuo: "Contínuo",
};

const KIND_STYLE: Record<MapaNodeKind, { fill: string; stroke: string; text: string; bold: boolean }> = {
  centro: { fill: PDF_COLORS.green, stroke: PDF_COLORS.green, text: "#FFFFFF", bold: true },
  ramo: { fill: "#E3F1EE", stroke: PDF_COLORS.green, text: PDF_COLORS.ink, bold: true },
  no: { fill: "#FFFFFF", stroke: PDF_COLORS.green, text: PDF_COLORS.ink, bold: false },
  evitar: { fill: "#FBEAE6", stroke: PDF_COLORS.negative, text: PDF_COLORS.ink, bold: false },
};

const clip = (text: string, maxChars: number): string => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

// Mapa mental do plano de ação, desenhado em SVG em faixas (centro + 1ª fileira, depois uma por fileira).
// Cada faixa não quebra e flui entre páginas; o mapa nunca é reduzido para caber em uma página só.
export function MapaMentalPdf({ mapa }: { mapa: MapaMental }) {
  const layout = layoutMapaMental(mapa, { width: PDF_PAGE.contentWidth });
  const bands = layout.bandTops.map((top, i) => ({ top, bottom: layout.bandTops[i + 1] ?? layout.height }));
  return (
    <View>
      {bands.map(({ top, bottom }) => {
        const h = bottom - top;
        const scale = Math.min(1, MAX_BAND_HEIGHT / h);
        const nodes = layout.nodes.filter((n) => n.y < bottom && n.y + n.h > top);
        const edges = layout.edges.filter((e) => e.y2 > top && e.y1 < bottom);
        return (
          <View key={top} wrap={false}>
            <Svg width={layout.width * scale} height={h * scale} viewBox={`0 ${top} ${layout.width} ${h}`}>
              {edges.map((e) => (
                <Line key={`${e.from}-${e.to}`} x1={e.x1} y1={Math.max(e.y1, top)} x2={e.x2} y2={Math.min(e.y2, bottom)} stroke={PDF_COLORS.muted} strokeWidth={0.8} />
              ))}
              {nodes.flatMap((n) => {
                const s = KIND_STYLE[n.kind];
                const font = s.bold ? PDF_FONT_FAMILY_BOLD : PDF_FONT_FAMILY;
                const meta = [n.prazo ? (PRAZO_LABEL[n.prazo] ?? n.prazo) : null, n.dono].filter(Boolean).join(" · ");
                return [
                  <Rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} fill={s.fill} stroke={s.stroke} strokeWidth={0.8} />,
                  ...n.lines.map((line, i) => (
                    <Text key={`${n.id}-${i}`} x={n.x + BOX_PAD_X} y={n.y + BOX_PAD_Y + LINE_H * (i + 1) - 2} fill={s.text} style={{ fontSize: FONT, fontFamily: font }}>
                      {line}
                    </Text>
                  )),
                  ...(meta
                    ? [
                        <Text key={`${n.id}-m`} x={n.x + BOX_PAD_X} y={n.y + n.h - 4} fill={PDF_COLORS.muted} style={{ fontSize: META_FONT, fontFamily: PDF_FONT_FAMILY }}>
                          {clip(meta, Math.floor((n.w - 2 * BOX_PAD_X) / META_CHAR_W))}
                        </Text>,
                      ]
                    : []),
                ];
              })}
            </Svg>
          </View>
        );
      })}
      <View style={{ flexDirection: "row", marginTop: 4 }}>
        {(["ramo", "evitar"] as const).map((k) => (
          <View key={k} style={{ flexDirection: "row", alignItems: "center", marginRight: 14 }}>
            <View style={{ width: 9, height: 9, marginRight: 4, backgroundColor: KIND_STYLE[k].fill, borderWidth: 0.8, borderColor: KIND_STYLE[k].stroke }} />
            <Text style={{ fontSize: META_FONT, color: PDF_COLORS.muted, fontFamily: PDF_FONT_FAMILY }}>
              {k === "ramo" ? "Etapa do plano" : "O que evitar"}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
