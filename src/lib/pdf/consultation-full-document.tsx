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

import type { ConsultationView } from "@/lib/consultations/view-model";

import { OpinionBlock } from "./markdown-pdf";
import type { OpinionForPdf } from "./markdown-pdf";

// Re-export para os imports existentes (ex.: a route do PDF).
export type { OpinionForPdf };

export interface FullPdfHeader {
  name: string;
  cpf: string; // documento formatado (CPF ou CNPJ)
  docLabel?: string; // "CPF" (default) ou "CNPJ"
  produto: string;
  data: string;
  consultante: string;
  usuario: string;
  endereco?: string;
}

// ── Constantes / estilo ──────────────────────────────────────────────────

const A4_W = 595.28;
const A4_H = 841.89;
const PAD_X = 42;
const CONTENT_W = A4_W - PAD_X * 2;
const HEADER_W = 340;

const teal = "#0F6E6E";
const darkGreen = "#0C3B3B";
const muted = "#6b7280";
const border = "#e5e7eb";
const gold = "#9A6A00";
const slate = "#475569";

const RISK_BANDS = [
  { label: "Muito alto", color: "#C92A2A", from: 300, to: 553 },
  { label: "Alto", color: "#E8590C", from: 553, to: 725 },
  { label: "Médio", color: "#F08C00", from: 725, to: 874 },
  { label: "Baixo", color: "#94C748", from: 874, to: 937 },
  { label: "Muito baixo", color: "#2F9E44", from: 937, to: 1000 },
];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const orDash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 7.5,
    lineHeight: 1.35,
    color: "#1f2937",
    paddingTop: 140,
    paddingBottom: 78,
    paddingHorizontal: PAD_X,
  },
  bg: { position: "absolute", top: 0, left: 0, width: A4_W, height: A4_H },
  header: { maxWidth: HEADER_W },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold", color: darkGreen, lineHeight: 1.2 },
  sub: { fontSize: 7, color: muted, marginTop: 2, lineHeight: 1.3 },
  section: { marginTop: 10 },
  h: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    color: teal,
    marginBottom: 5,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: border,
  },
  sh: { fontSize: 9, fontFamily: "Helvetica-Bold", color: gold, marginTop: 5, marginBottom: 3 },
  ssh: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: slate, marginTop: 4, marginBottom: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gItem: { width: CONTENT_W / 2, marginBottom: 5 },
  label: { fontSize: 6.5, color: muted },
  val: { fontSize: 8, lineHeight: 1.3 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: border, paddingVertical: 3 },
  th: { fontSize: 7, fontFamily: "Helvetica-Bold", color: muted },
  td: { fontSize: 7.5, lineHeight: 1.25 },
  li: { fontSize: 8, marginBottom: 2, lineHeight: 1.3 },
  card: { borderWidth: 1, borderColor: border, borderRadius: 4, padding: 6 },
  cardLabel: { fontSize: 7, color: muted },
  cardValue: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 2 },
});

// ── Helpers visuais ─────────────────────────────────────────────────────

function Marker({ x, top = -9 }: { x: number; top?: number }) {
  return (
    <Svg width={10} height={7} style={{ position: "absolute", top, left: x - 5 }}>
      <Polygon points="0,0 10,0 5,7" fill={darkGreen} />
    </Svg>
  );
}

function ScoreBar({ valor }: { valor: number }) {
  const x = clamp((valor - 300) / 700, 0, 1) * CONTENT_W;
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ position: "relative", width: CONTENT_W }}>
        <Marker x={x} />
        <View style={{ flexDirection: "row", height: 16, borderRadius: 2, overflow: "hidden" }}>
          {RISK_BANDS.map((b) => (
            <View
              key={b.label}
              style={{ width: ((b.to - b.from) / 700) * CONTENT_W, backgroundColor: b.color }}
            />
          ))}
        </View>
      </View>
      <View style={{ flexDirection: "row", marginTop: 3 }}>
        {RISK_BANDS.map((b, i) => (
          <Text
            key={b.label}
            style={{
              width: ((b.to - b.from) / 700) * CONTENT_W,
              fontSize: 6.5,
              color: muted,
              textAlign: "center",
            }}
          >
            {i === 0 ? `${b.label} (+ risco)` : i === RISK_BANDS.length - 1 ? `${b.label} (- risco)` : b.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.section} minPresenceAhead={72}>
      <Text style={s.h} wrap={false}>{title}</Text>
      {children}
    </View>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.gItem}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.val}>{value || "—"}</Text>
    </View>
  );
}
function Cards({ items }: { items: { label: string; value: string }[] }) {
  const w = (CONTENT_W - (items.length - 1) * 8) / items.length;
  return (
    <View style={{ flexDirection: "row", marginTop: 4 }} wrap={false}>
      {items.map((it, i) => (
        <View key={it.label} style={[s.card, { width: w, marginRight: i === items.length - 1 ? 0 : 8 }]}>
          <Text style={s.cardLabel}>{it.label}</Text>
          <Text style={s.cardValue}>{it.value}</Text>
        </View>
      ))}
    </View>
  );
}
function Table({ cols, widths, rows }: { cols: string[]; widths: number[]; rows: (string | number)[][] }) {
  const Header = (
    <View style={[s.tr, { backgroundColor: "#fff" }]} fixed>
      {cols.map((c, i) => (
        <Text key={i} style={[s.th, { width: widths[i] * CONTENT_W }]}>{c}</Text>
      ))}
    </View>
  );
  return (
    <View style={{ marginTop: 2 }} minPresenceAhead={24}>
      {Header}
      {rows.map((r, ri) => (
        <View key={ri} style={s.tr} wrap={false}>
          {r.map((cell, ci) => (
            <Text key={ci} style={[s.td, { width: widths[ci] * CONTENT_W }]}>{String(cell)}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function Bg({ letterhead }: { letterhead: string }) {
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image src={letterhead} style={s.bg} fixed />;
}

// Estilos compartilhados com o PDF do processamento de empresa.
export const pdfStyles = s;

// ── Documento ──────────────────────────────────────────────────────────

export interface FullConsultationPageProps {
  view: ConsultationView;
  header: FullPdfHeader;
  letterhead: string;
  opinion?: OpinionForPdf | null;
}

export function FullConsultationPage({
  view,
  header,
  letterhead,
  opinion,
}: FullConsultationPageProps) {
  const { subject, score } = view;

  return (
    <Page size="A4" style={s.page}>
      <Bg letterhead={letterhead} />

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={s.header}>
          <Text style={s.title}>{header.name}</Text>
          <Text style={s.sub}>{header.docLabel ?? "CPF"} {header.cpf} · {header.data}</Text>
          <Text style={s.sub}>Confidencial para {header.consultante} · Usuário {header.usuario}</Text>
          {header.endereco ? <Text style={s.sub}>{header.endereco}</Text> : null}
        </View>
      </View>

      {!score.empty && score.value != null && (
        <Section title="Score">
          <View wrap={false}>
            <View style={{ flexDirection: "row", alignItems: "flex-end", height: 26 }}>
              <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: darkGreen, lineHeight: 1 }}>{score.value}</Text>
              <Text style={{ fontSize: 10, marginLeft: 8, marginBottom: 2, color: muted }}>{orDash(score.riskBand)}</Text>
            </View>
            <Text style={{ fontSize: 7.5, color: muted, marginTop: 4 }}>
              Faixa de risco de crédito — quanto maior o score, menor o risco de inadimplência.
            </Text>
            <ScoreBar valor={score.value} />
            {score.description ? (
              <Text style={{ fontSize: 8, color: muted, marginTop: 6 }}>{score.description}</Text>
            ) : null}
            {score.paymentProbability != null ? (
              <Text style={{ fontSize: 8, color: muted, marginTop: 2 }}>
                Probabilidade de pagamento: {score.paymentProbability}%
              </Text>
            ) : null}
          </View>
        </Section>
      )}

      <View style={s.section} wrap={false}>
        <Text style={s.h}>Restrições</Text>
        <Cards
          items={[
            { label: "Pendências", value: String(view.debts.total) },
            { label: "Protestos", value: String(view.protests.total) },
            { label: "Ações judiciais", value: String(view.lawsuits.total) },
            { label: "Total pendências", value: view.debts.amount },
          ]}
        />
      </View>

      <View style={[s.header, { marginTop: 22 }]} minPresenceAhead={90}>
        <Text style={[s.title, { color: teal }]}>Dados na íntegra</Text>
        <Text style={s.sub}>{header.name} · {header.docLabel ?? "CPF"} {header.cpf}</Text>
      </View>

      <Section title={view.kind === "PJ" ? "Identificação da empresa" : "Identificação"}>
        <View style={s.grid}>
          <Field label="Nome" value={subject.name} />
          {view.kind === "PJ" ? (
            <>
              <Field label="Nome fantasia" value={orDash(subject.tradeName)} />
              <Field label="Situação cadastral" value={orDash(subject.registrationStatus)} />
              <Field label="Início de atividade" value={orDash(subject.startDate)} />
              <Field label="Natureza jurídica" value={orDash(subject.legalNature)} />
              <Field label="CNAE principal" value={orDash(subject.mainActivity)} />
              <Field label="Porte" value={orDash(subject.companySize)} />
              <Field label="Capital social" value={orDash(subject.capital)} />
              <Field label="Cidade / UF" value={orDash(subject.location)} />
            </>
          ) : (
            <>
              <Field label="Situação cadastral" value={orDash(subject.registrationStatus)} />
              <Field
                label="Nascimento"
                value={`${orDash(subject.birthDate)}${subject.age != null ? ` · ${subject.age} anos` : ""}`}
              />
              <Field label="Nome da mãe" value={orDash(subject.motherName)} />
              <Field label="Óbito" value={subject.isDeceased ? "Sim" : "Não"} />
              <Field label="Politicamente exposta" value={subject.isPoliticallyExposed ? "Sim" : "Não"} />
              <Field label="Cidade / UF" value={orDash(subject.location)} />
            </>
          )}
        </View>
      </Section>

      {!view.ownership.empty && (
        <Section title="Quadro societário">
          <Table
            cols={["Nome", "Cargo", "Part."]}
            widths={[0.6, 0.28, 0.12]}
            rows={view.ownership.items.map((o) => [
              orDash(o.name),
              orDash(o.role),
              o.sharePct != null ? `${o.sharePct}%` : "—",
            ])}
          />
        </Section>
      )}

      {!view.participation.empty && (
        <Section title="Participações em empresas">
          <Table
            cols={["Nome", "Cargo", "Part."]}
            widths={[0.6, 0.28, 0.12]}
            rows={view.participation.items.map((p) => [
              orDash(p.name),
              orDash(p.role),
              p.sharePct != null ? `${p.sharePct}%` : "—",
            ])}
          />
        </Section>
      )}

      {!view.queries.empty && (
        <Section title="Consultas anteriores">
          <Table
            cols={["Últimos 30d", "31-60d", "61-90d", "90d+"]}
            widths={[0.25, 0.25, 0.25, 0.25]}
            rows={[[
              view.queries.last30Days ?? 0,
              view.queries.last31To60Days ?? 0,
              view.queries.last61To90Days ?? 0,
              view.queries.over90Days ?? 0,
            ]]}
          />
          {view.queries.items.length > 0 && (
            <Table
              cols={["Data", "Segmento", "Quantidade"]}
              widths={[0.34, 0.46, 0.2]}
              rows={view.queries.items.map((d) => [orDash(d.date), orDash(d.segment), d.count ?? 0])}
            />
          )}
        </Section>
      )}

      <Section title="Ações judiciais">
        {view.lawsuits.empty ? (
          <Text style={s.li}>Nada consta.</Text>
        ) : (
          <Table
            cols={["Ação", "Local", "Data", "Valor"]}
            widths={[0.34, 0.3, 0.16, 0.2]}
            rows={view.lawsuits.items.map((o) => [
              orDash(o.kind),
              orDash(o.location),
              orDash(o.date),
              o.amount,
            ])}
          />
        )}
      </Section>

      <Section title="Pendências e restrições">
        {view.debts.empty ? (
          <Text style={s.li}>Nada consta.</Text>
        ) : (
          <>
            <Text style={s.li}>{view.debts.total} ocorrência(s) · Total {view.debts.amount}</Text>
            <Table
              cols={["Informante", "Tipo", "Valor", "Data", "Local"]}
              widths={[0.32, 0.18, 0.16, 0.14, 0.2]}
              rows={view.debts.items.map((o) => [
                orDash(o.source),
                orDash(o.kind),
                o.amount,
                orDash(o.date),
                orDash(o.location),
              ])}
            />
          </>
        )}
      </Section>

      <Section title="Protestos">
        {view.protests.empty ? (
          <Text style={s.li}>Nada consta.</Text>
        ) : (
          <>
            <Text style={s.li}>
              {view.protests.total} ocorrência(s) · Total {view.protests.amount}
            </Text>
            {view.protests.items.length > 0 && (
              <Table
                cols={["Cartório", "UF", "Data", "Valor"]}
                widths={[0.56, 0.08, 0.16, 0.2]}
                rows={view.protests.items.map((o) => [
                  orDash(o.registry),
                  orDash(o.state),
                  orDash(o.date),
                  o.amount,
                ])}
              />
            )}
          </>
        )}
      </Section>

      <Section title="Restrições de cheques">
        {view.checks.empty ? (
          <Text style={s.li}>Nada consta.</Text>
        ) : (
          <>
            <Text style={s.li}>Devolvidos sem fundo: {orDash(view.checks.returnedNoFunds)}</Text>
            <Text style={s.li}>Sustados: {orDash(view.checks.stopped)}</Text>
            {view.checks.note ? <Text style={s.li}>{view.checks.note}</Text> : null}
          </>
        )}
      </Section>

      {view.messages.length > 0 && (
        <Section title="Mensagens do bureau">
          {view.messages.map((m, i) => (
            <Text key={i} style={s.li}>• {m}</Text>
          ))}
        </Section>
      )}

      {opinion && (
        <Section title="Parecer de IA">
          <OpinionBlock opinion={opinion} />
        </Section>
      )}

      <Text style={{ fontSize: 7, color: muted, marginTop: 20, textAlign: "right" }}>
        Documento gerado automaticamente · Reino do Crédito
      </Text>
    </Page>
  );
}

function FullDocument(props: FullConsultationPageProps) {
  return (
    <Document>
      <FullConsultationPage {...props} />
    </Document>
  );
}

export function renderFullConsultationPdf(
  view: ConsultationView,
  header: FullPdfHeader,
  letterhead: string,
  opinion?: OpinionForPdf | null
): Promise<Buffer> {
  return renderToBuffer(
    <FullDocument view={view} header={header} letterhead={letterhead} opinion={opinion} />
  );
}
