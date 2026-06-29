import type { ReactNode } from "react";
import {
  Document,
  Page,
  View,
  Text,
  Image,
  Svg,
  Polygon,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";

// ── Dados ────────────────────────────────────────────────────────────────

export interface PdfFactor {
  descricao: string;
  pontuacao: number;
}

export interface ConsultationPdfData {
  header: {
    name: string;
    document: string;
    type: "PF" | "PJ";
    product: string;
    date: string;
    status: string;
  };
  score: {
    valor: number | null;
    risco: string | null;
    descricao: string | null;
    prob: number | null;
  };
  smart: {
    classificacao: string | null;
    aprovado: boolean | null;
    motivo: string | null;
    limiteSugerido: number | null;
  };
  positivas: PdfFactor[];
  negativas: PdfFactor[];
  restricoes: {
    pendenciasTotal: number;
    pendenciasValor: number;
    protestos: number;
    acoes: number;
    chequesSemFundo: number | null;
  };
  pf?: {
    rendaPresumida: number | null;
    scrRiscoTotal: number | null;
    scrCarteiraAtiva: number | null;
    scrLimiteCredito: number | null;
  };
  pj?: {
    situacao: string | null;
    abertura: string | null;
    cnae: string | null;
    capital: number | null;
    porte: string | null;
    socios: { nome: string; participacao: number | null; cargo: string | null }[];
  };
}

// ── Constantes ─────────────────────────────────────────────────────────

const A4_W = 595.28;
const A4_H = 841.89;
const PAD_X = 42;
const CONTENT_W = A4_W - PAD_X * 2; // ~511

const teal = "#0F6E6E";
const darkGreen = "#0C3B3B";
const muted = "#6b7280";
const text = "#1f2937";
const border = "#e5e7eb";

const RISK_BANDS = [
  { label: "Muito alto", color: "#C92A2A", from: 300, to: 553 },
  { label: "Alto", color: "#E8590C", from: 553, to: 725 },
  { label: "Médio", color: "#F08C00", from: 725, to: 874 },
  { label: "Baixo", color: "#94C748", from: 874, to: 937 },
  { label: "Muito baixo", color: "#2F9E44", from: 937, to: 1000 },
];
const SMART_LEVELS = ["E", "D", "C", "B", "BB", "BBB", "A", "AA", "AAA"];
const SMART_COLORS = [
  "#C92A2A", "#E03131", "#F03E3E", "#E8590C", "#F08C00",
  "#F6B100", "#A9C94A", "#5FB83D", "#2F9E44",
];

const brl = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(n);

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ── Estilos ──────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: text,
    paddingTop: 118,
    paddingBottom: 58,
    paddingHorizontal: PAD_X,
  },
  bg: { position: "absolute", top: 0, left: 0, width: A4_W, height: A4_H },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", color: darkGreen },
  subtitle: { fontSize: 9, color: muted, marginTop: 2 },
  section: { marginTop: 14 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: teal,
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: border,
  },
  infoGrid: { flexDirection: "row", flexWrap: "wrap" },
  infoItem: { width: CONTENT_W / 2, marginBottom: 4 },
  infoLabel: { fontSize: 7.5, color: muted },
  infoValue: { fontSize: 10 },
  row: { flexDirection: "row" },
  barTrack: { flexDirection: "row", height: 16, borderRadius: 2, overflow: "hidden" },
  bandLabels: { flexDirection: "row", marginTop: 3 },
  cardRow: { flexDirection: "row", marginTop: 4 },
  card: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: 4,
    padding: 8,
    marginRight: 8,
  },
  cardLabel: { fontSize: 7.5, color: muted },
  cardValue: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 2 },
  twoCol: { flexDirection: "row" },
  col: { flex: 1 },
  factorLine: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  badge: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: "#fff",
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 3,
  },
});

// ── Sub-componentes ──────────────────────────────────────────────────────

function Marker({ x }: { x: number }) {
  return (
    <Svg width={10} height={7} style={{ position: "absolute", top: -9, left: x - 5 }}>
      <Polygon points="0,0 10,0 5,7" fill={darkGreen} />
    </Svg>
  );
}

function ScoreBar({ valor }: { valor: number | null }) {
  const markerX = valor == null ? -100 : clamp((valor - 300) / 700, 0, 1) * CONTENT_W;
  return (
    <View>
      <View style={{ position: "relative", width: CONTENT_W }}>
        {valor != null && <Marker x={markerX} />}
        <View style={s.barTrack}>
          {RISK_BANDS.map((b) => (
            <View
              key={b.label}
              style={{
                width: ((b.to - b.from) / 700) * CONTENT_W,
                backgroundColor: b.color,
              }}
            />
          ))}
        </View>
      </View>
      <View style={s.bandLabels}>
        {RISK_BANDS.map((b) => (
          <Text
            key={b.label}
            style={{
              width: ((b.to - b.from) / 700) * CONTENT_W,
              textAlign: "center",
              fontSize: 6.5,
              color: muted,
            }}
          >
            {b.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function SmartScale({ classificacao }: { classificacao: string | null }) {
  const seg = CONTENT_W / SMART_LEVELS.length;
  const idx = classificacao ? SMART_LEVELS.indexOf(classificacao) : -1;
  const markerX = idx >= 0 ? (idx + 0.5) * seg : -100;
  return (
    <View style={{ position: "relative", width: CONTENT_W }}>
      {idx >= 0 && <Marker x={markerX} />}
      <View style={s.barTrack}>
        {SMART_LEVELS.map((lvl, i) => (
          <View
            key={lvl}
            style={{
              width: seg,
              backgroundColor: SMART_COLORS[i],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 7, color: "#fff", fontFamily: "Helvetica-Bold" }}>
              {lvl}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  const w = clamp(pct, 0, 100);
  return (
    <View style={{ marginTop: 4 }}>
      <View style={s.factorLine}>
        <Text style={{ fontSize: 8, color: muted }}>{label}</Text>
        <Text style={{ fontSize: 8 }}>{w}%</Text>
      </View>
      <View style={{ height: 8, backgroundColor: border, borderRadius: 4 }}>
        <View
          style={{
            height: 8,
            width: (w / 100) * CONTENT_W,
            backgroundColor: teal,
            borderRadius: 4,
          }}
        />
      </View>
    </View>
  );
}

function Cards({ items }: { items: { label: string; value: string }[] }) {
  const w = (CONTENT_W - (items.length - 1) * 8) / items.length;
  return (
    <View style={s.cardRow}>
      {items.map((it, i) => (
        <View
          key={it.label}
          style={[s.card, { width: w, marginRight: i === items.length - 1 ? 0 : 8 }]}
        >
          <Text style={s.cardLabel}>{it.label}</Text>
          <Text style={s.cardValue}>{it.value}</Text>
        </View>
      ))}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.infoItem}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  );
}

// ── Documento ──────────────────────────────────────────────────────────

function ConsultationDocument({
  data,
  letterhead,
  opinion,
}: {
  data: ConsultationPdfData;
  letterhead: string;
  opinion?: OpinionForPdf | null;
}) {
  const { header, score, smart } = data;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={letterhead} style={s.bg} fixed />

        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View>
            <Text style={s.title}>Relatório de Consulta</Text>
            <Text style={s.subtitle}>
              {header.product} · {header.date}
            </Text>
          </View>
          <Text style={[s.badge, { backgroundColor: teal }]}>{header.status}</Text>
        </View>

        <Section title="Cliente">
          <View style={s.infoGrid}>
            <Info label="Nome" value={header.name} />
            <Info label="Documento" value={header.document} />
            <Info label="Tipo" value={header.type === "PJ" ? "Pessoa Jurídica" : "Pessoa Física"} />
            <Info label="Produto" value={header.product} />
          </View>
        </Section>

        <Section title="Score">
          <View style={{ flexDirection: "row", alignItems: "baseline", marginBottom: 6 }}>
            <Text style={{ fontSize: 26, fontFamily: "Helvetica-Bold", color: darkGreen }}>
              {score.valor ?? "—"}
            </Text>
            <Text style={{ fontSize: 11, marginLeft: 8, color: muted }}>
              {score.risco ?? ""}
            </Text>
          </View>
          <ScoreBar valor={score.valor} />
          {score.descricao && (
            <Text style={{ fontSize: 8.5, color: muted, marginTop: 6 }}>
              {score.descricao}
            </Text>
          )}
          {score.prob != null && (
            <ProgressBar pct={score.prob} label="Probabilidade de pagamento" />
          )}
        </Section>

        <Section title="Classificação Smart">
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={{ fontSize: 12, fontFamily: "Helvetica-Bold" }}>
              {smart.classificacao ?? "—"}
            </Text>
            {smart.aprovado != null && (
              <Text
                style={[
                  s.badge,
                  { backgroundColor: smart.aprovado ? "#2F9E44" : "#C92A2A" },
                ]}
              >
                {smart.aprovado ? "Aprovado" : "Reprovado"}
              </Text>
            )}
          </View>
          <SmartScale classificacao={smart.classificacao} />
          <View style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 9 }}>
              Limite sugerido:{" "}
              <Text style={{ fontFamily: "Helvetica-Bold" }}>
                {brl(smart.limiteSugerido)}
              </Text>
            </Text>
            {smart.motivo && (
              <Text style={{ fontSize: 8.5, color: muted, marginTop: 2 }}>
                {smart.motivo}
              </Text>
            )}
          </View>
        </Section>

        {(data.positivas.length > 0 || data.negativas.length > 0) && (
          <Section title="Fatores Smart">
            <View style={s.twoCol}>
              <View style={[s.col, { marginRight: 12 }]}>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#2F9E44", marginBottom: 3 }}>
                  Pontos positivos
                </Text>
                {data.positivas.length === 0 && (
                  <Text style={{ fontSize: 8, color: muted }}>—</Text>
                )}
                {data.positivas.map((p, i) => (
                  <View key={i} style={s.factorLine}>
                    <Text style={{ fontSize: 8 }}>{p.descricao}</Text>
                    <Text style={{ fontSize: 8, color: muted }}>+{p.pontuacao}</Text>
                  </View>
                ))}
              </View>
              <View style={s.col}>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#C92A2A", marginBottom: 3 }}>
                  Pontos de atenção
                </Text>
                {data.negativas.length === 0 && (
                  <Text style={{ fontSize: 8, color: muted }}>—</Text>
                )}
                {data.negativas.map((n, i) => (
                  <View key={i} style={s.factorLine}>
                    <Text style={{ fontSize: 8 }}>{n.descricao}</Text>
                    <Text style={{ fontSize: 8, color: muted }}>{n.pontuacao}</Text>
                  </View>
                ))}
              </View>
            </View>
          </Section>
        )}

        <Section title="Restrições">
          <Cards
            items={[
              { label: "Pendências", value: String(data.restricoes.pendenciasTotal) },
              { label: "Valor pendências", value: brl(data.restricoes.pendenciasValor) },
              { label: "Protestos", value: String(data.restricoes.protestos) },
              { label: "Ações judiciais", value: String(data.restricoes.acoes) },
            ]}
          />
        </Section>

        {data.pf && (
          <Section title="Renda e SCR">
            <Cards
              items={[
                { label: "Renda presumida", value: brl(data.pf.rendaPresumida) },
                { label: "SCR risco total", value: brl(data.pf.scrRiscoTotal) },
                { label: "Carteira ativa", value: brl(data.pf.scrCarteiraAtiva) },
                { label: "Limite SCR", value: brl(data.pf.scrLimiteCredito) },
              ]}
            />
          </Section>
        )}

        {data.pj && (
          <Section title="Empresa">
            <View style={s.infoGrid}>
              <Info label="Situação cadastral" value={data.pj.situacao ?? "—"} />
              <Info label="Início de atividade" value={data.pj.abertura ?? "—"} />
              <Info label="CNAE principal" value={data.pj.cnae ?? "—"} />
              <Info label="Porte" value={data.pj.porte ?? "—"} />
              <Info label="Capital social" value={brl(data.pj.capital)} />
            </View>
            {data.pj.socios.length > 0 && (
              <View style={{ marginTop: 6 }}>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", marginBottom: 3 }}>
                  Quadro societário
                </Text>
                {data.pj.socios.map((soc, i) => (
                  <View key={i} style={s.factorLine}>
                    <Text style={{ fontSize: 8 }}>{soc.nome}</Text>
                    <Text style={{ fontSize: 8, color: muted }}>
                      {soc.cargo ?? ""}
                      {soc.participacao != null ? ` · ${soc.participacao}%` : ""}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </Section>
        )}

        {/* Parecer de IA — wrappável (pagina sozinho; não usa o Section com
            wrap={false}, que cortaria o relatório completo). */}
        {opinion && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Parecer de IA</Text>
            <OpinionBlock opinion={opinion} />
          </View>
        )}

        <Text style={{ fontSize: 7, color: muted, marginTop: 16 }} fixed>
          Documento gerado automaticamente · Reino do Crédito · Dados do bureau deps.com.br
        </Text>
      </Page>
    </Document>
  );
}

export function renderConsultationPdf(
  data: ConsultationPdfData,
  letterhead: string,
  opinion?: OpinionForPdf | null
): Promise<Buffer> {
  return renderToBuffer(
    <ConsultationDocument data={data} letterhead={letterhead} opinion={opinion} />
  );
}
