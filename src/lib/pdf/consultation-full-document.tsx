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

import { summarizeProtestos } from "@/lib/deps/protestos";

import { OpinionBlock } from "./markdown-pdf";
import type { OpinionForPdf } from "./markdown-pdf";

// Re-export para os imports existentes (ex.: a route do PDF).
export type { OpinionForPdf };

// ── Tipos do mix real (Smart PF 002) — campos que renderizamos ──────────

interface Mod<T> {
  success?: boolean;
  message?: string | null;
  data: T | null;
}
interface Metrica {
  metrica: string;
  descricao: string;
  pontuacao: number;
  impacto: number;
  percentualMetrica: number;
}
interface ScrItem {
  descricao: string;
  valor: number;
  percentual?: string;
}
interface ScrTotalBlock {
  descricaoTotal?: string;
  descricao?: string;
  valorTotal?: number;
  valor?: number;
  percentualTotal?: string;
  percentual?: string;
  itens?: ScrItem[];
}
type Ocorrencia = Record<string, unknown>;

// Indicador comportamental (opcional — nem toda consulta traz).
export interface ComportamentalIndicador {
  descricao: string;
  // 0–100 (CRÍTICO → EXCELENTE). Se ausente, a barra aparece sem marcador.
  nivel?: number | null;
}

export interface PfMix {
  pessoa?: Mod<{
    cpf?: string;
    nome?: string;
    nomeMae?: string;
    idade?: number;
    situacaoCadastral?: string;
    dataNascimento?: string;
    nacionalidade?: string | null;
    identidade?: string | null;
    escolaridade?: string | null;
    dadosCadastrais?: {
      uf?: string;
      cidade?: string;
      endereco?: string;
      numero?: string;
      bairro?: string;
      cep?: string;
      complemento?: string | null;
    };
  }>;
  // ── PJ (Smart PJ 010) — identidade/quadro/faturamento ──
  empresa?: Mod<{
    cnpj?: string;
    razaoSocial?: string;
    nomeFantasia?: string | null;
    situacaoCadastral?: string;
    dataInicioAtividade?: string;
    naturezaJuridica?: string;
    cnaePrincipal?: string;
    cnaesSecundarios?: string[] | null;
    capitalSocial?: number;
    porte?: string;
    nire?: string;
    tipoUnidade?: string;
    uf?: string;
    municipio?: string;
    bairro?: string;
    endereco?: string;
    numero?: string;
    complemento?: string | null;
    cep?: string;
  }>;
  quadroSocietario?: Mod<{
    comParticipacao?: boolean;
    quadroSocietario?: {
      nome?: string;
      documento?: string;
      participacao?: number | null;
      cargoSociedade?: string | null;
      situacao?: string | null;
      dataEntrada?: string | null;
      restricao?: boolean;
    }[];
  }>;
  faturamentoPresumido?: Mod<{
    faturamentoPresumido?: string;
    valor?: number;
    valorMinimo?: number;
    valorMaximo?: number;
  }>;
  score?: Mod<{ score?: number; risco?: string; descricao?: string }>;
  rendaPresumida?: Mod<{ rendaPresumida?: string; valorMinimo?: number; valorMaximo?: number }>;
  scr?: Mod<{
    vencimentosConsolidados?: {
      informacaoConsulta?: { descricao: string; valor: string }[];
      itensAVencer?: ScrTotalBlock;
      itensVencidos?: ScrTotalBlock;
    };
    vencimentoPorModalidade?: {
      vencimentoPorModalidades?: ScrTotalBlock[];
      carteiraAtiva?: ScrTotalBlock;
      responsabilidadeTotal?: ScrTotalBlock;
      limiteCredito?: ScrTotalBlock;
      riscoTotal?: ScrTotalBlock;
      prejuizo?: ScrTotalBlock;
    };
  }>;
  smart?: Mod<{
    classificacao?: {
      classificacao?: string;
      limiteSugerido?: number;
      validade?: string;
      pontuacaoAtingida?: number;
      politica?: string;
      porte?: string;
    };
    positivas?: Metrica[];
    negativas?: Metrica[];
    parecer?: {
      aprovado?: boolean;
      motivo?: string;
      resultadoParecer?: {
        nome: string;
        atendido: boolean;
        regras?: { descricao: string; resultado?: string[]; motivo?: string }[];
      }[];
    };
    historicoClassificacao?: { dataHora: string; classificacao: string }[];
  }>;
  comportamental?: Mod<ComportamentalIndicador[]>;
  participacaoEmpresa?: Mod<
    {
      cnpj?: string;
      situacaoReceita?: string;
      nome?: string;
      cargo?: string;
      dataEntrada?: string;
      percentualParticipacao?: number;
      dataUltimaAtualizacao?: string;
    }[]
  >;
  outrosEnderecos?: Mod<
    {
      endereco?: string;
      numero?: string;
      complemento?: string | null;
      cep?: string;
      uf?: string;
      municipio?: string;
      bairro?: string;
    }[]
  >;
  contatosPreferenciais?: Mod<
    { nome?: string | null; telefone?: string; operadora?: string | null; whatsapp?: string | null }[]
  >;
  emails?: Mod<string[]>;
  consultas?: Mod<{
    contagemUltimos30Dias?: number | null;
    contagemUltimos31a60Dias?: number | null;
    contagemUltimos61a90Dias?: number | null;
    contagem90DiasMais?: number | null;
    detalhes?: { dataConsulta?: string; quantidadeConsultas?: number; segmento?: string }[] | null;
  }>;
  acoesJudiciais?: Mod<{
    totalAcoes?: number;
    valorTotal?: number;
    ocorrencias?: {
      acao?: string | null;
      foro?: string | null;
      vara?: string | null;
      comarca?: string | null;
      uf?: string | null;
      autor?: string | null;
      requerido?: string | null;
      processo?: string | null;
      distribuicao?: string | null;
      valor?: number | null;
    }[];
  }> & { message?: string | null };
  protestos?: Mod<Ocorrencia[]> & { message?: string | null };
  pendenciasRestricoes?: Mod<{
    totalPendencias?: number;
    totalCredores?: number;
    nivel?: string | null;
    valor?: number | null;
    ocorrencias?: {
      informante?: string | null;
      tipo?: string | null;
      valor?: number | null;
      dataDebito?: string | null;
      numeroContrato?: string | null;
      uf?: string | null;
      cidade?: string | null;
    }[];
  }> & { message?: string | null };
  restricoesCheques?: {
    chequesDevolvidosSemFundo?: { message?: string | null };
    chequesDevolvidosOutrosMotivos?: { message?: string | null };
  };
}

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
// Largura segura do cabeçalho: mantém o texto à esquerda da chave do timbrado
// e do selo de Parecer (topo direito).
const HEADER_W = 340;

const teal = "#0F6E6E";
const darkGreen = "#0C3B3B";
const muted = "#6b7280";
const border = "#e5e7eb";
// Hierarquia de cores dos títulos: nível 1 (seção) = teal · nível 2 (subtítulo)
// = dourado/bronze · nível 3 (sub-subtítulo) = ardósia. Cores diferentes por nível.
const gold = "#9A6A00";
const slate = "#475569";

const RISK_BANDS = [
  { label: "Muito alto", color: "#C92A2A", from: 300, to: 553 },
  { label: "Alto", color: "#E8590C", from: 553, to: 725 },
  { label: "Médio", color: "#F08C00", from: 725, to: 874 },
  { label: "Baixo", color: "#94C748", from: 874, to: 937 },
  { label: "Muito baixo", color: "#2F9E44", from: 937, to: 1000 },
];
const SMART_LEVELS = ["E", "D", "C", "B", "BB", "BBB", "A", "AA", "AAA"];
const SMART_COLORS = ["#C92A2A","#E03131","#F03E3E","#E8590C","#F08C00","#F6B100","#A9C94A","#5FB83D","#2F9E44"];

const brl = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const dt = (sv?: string | null) => {
  if (!sv) return "—";
  const d = new Date(sv);
  return isNaN(d.getTime()) ? sv : d.toLocaleDateString("pt-BR");
};

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
  // A chave dourada do timbrado desce pela direita até ~y=168pt. Limitamos a
  // largura do cabeçalho a HEADER_W para o texto quebrar antes de colidir com ela.
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
  badge: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "#fff", paddingVertical: 3.5, paddingHorizontal: 8, borderRadius: 3 },
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
    // marginTop deixa o marcador (top -9) abaixo do número, sem sobrepor.
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
            {/* Reforça nas pontas o que a faixa significa (risco) */}
            {i === 0 ? `${b.label} (+ risco)` : i === RISK_BANDS.length - 1 ? `${b.label} (- risco)` : b.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function SmartScale({ classificacao }: { classificacao?: string }) {
  const seg = CONTENT_W / SMART_LEVELS.length;
  const idx = classificacao ? SMART_LEVELS.indexOf(classificacao) : -1;
  const H = 22;
  // marginTop generoso: o marcador (top -9) fica abaixo da linha do limite,
  // sem sobrepor o "Limite sugerido / Validade".
  return (
    <View style={{ position: "relative", width: CONTENT_W, marginTop: 14 }}>
      {idx >= 0 && <Marker x={(idx + 0.5) * seg} />}
      <View style={{ flexDirection: "row", height: H, borderRadius: 2, overflow: "hidden" }}>
        {SMART_LEVELS.map((lvl, i) => (
          <View
            key={lvl}
            style={{
              width: seg,
              height: H,
              backgroundColor: SMART_COLORS[i],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                fontSize: 8,
                color: "#fff",
                fontFamily: "Helvetica-Bold",
                lineHeight: 1,
              }}
            >
              {lvl}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  // minPresenceAhead garante espaço para o título + algumas linhas de conteúdo
  // na mesma página; se não couber, a seção inteira vai para a próxima — evita o
  // título sozinho no rodapé (ex.: "SCR" numa página e os dados na seguinte).
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
    // wrap={false}: os 4 cards ficam sempre na mesma página, nunca partidos.
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
  // O cabeçalho é `fixed` dentro da tabela: quando a tabela atravessa a quebra
  // de página, o react-pdf repete a linha de títulos no topo da continuação
  // (igual ao PDF da deps). `minPresenceAhead` evita header sozinho no rodapé.
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
function ScrBlock({ block }: { block?: ScrTotalBlock }) {
  if (!block) return null;
  const total = block.valorTotal ?? block.valor ?? 0;
  const pct = block.percentualTotal ?? block.percentual ?? "";
  const desc = block.descricaoTotal ?? block.descricao ?? "";
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={s.ssh} wrap={false}>{desc} — {brl(total)} {pct ? `(${pct})` : ""}</Text>
      {block.itens && block.itens.length > 0 && (
        <Table
          cols={["Descrição", "Valor", "%"]}
          widths={[0.66, 0.2, 0.14]}
          rows={block.itens.map((it) => [it.descricao, brl(it.valor), it.percentual ?? ""])}
        />
      )}
    </View>
  );
}

export function Bg({ letterhead }: { letterhead: string }) {
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image src={letterhead} style={s.bg} fixed />;
}

// Estilos compartilhados com o PDF do processamento de empresa (mesma capa /
// margens do timbrado em todas as páginas).
export const pdfStyles = s;

// ── Documento ──────────────────────────────────────────────────────────

export interface FullConsultationPageProps {
  mix: PfMix;
  header: FullPdfHeader;
  letterhead: string;
  opinion?: OpinionForPdf | null;
}

// Página completa de uma consulta (empresa ou sócio). Exportada para que o PDF
// do processamento de empresa a reaproveite — cada consulta vira uma <Page>, o
// que já garante a quebra de página entre uma e outra.
export function FullConsultationPage({
  mix,
  header,
  letterhead,
  opinion,
}: FullConsultationPageProps) {
  const pessoa = mix.pessoa?.data;
  const empresa = mix.empresa?.data;
  const quadro = mix.quadroSocietario?.data?.quadroSocietario;
  const faturamento = mix.faturamentoPresumido?.data;
  const score = mix.score?.data;
  const smart = mix.smart?.data;
  const scr = mix.scr?.data;
  const renda = mix.rendaPresumida?.data;

  const pendTotal = mix.pendenciasRestricoes?.data?.totalPendencias ?? 0;
  const acoesTotal = mix.acoesJudiciais?.data?.totalAcoes ?? 0;
  const protestosResumo = summarizeProtestos(mix.protestos?.data);
  const protestosTotal = protestosResumo.total;
  const riscoTotal = scr?.vencimentoPorModalidade?.riscoTotal?.valor ?? null;

  return (
    <Page size="A4" style={s.page}>
      <Bg letterhead={letterhead} />

        {/* Cabeçalho à esquerda + selo de Parecer compacto à direita. */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <View style={s.header}>
            <Text style={s.title}>{header.name}</Text>
            <Text style={s.sub}>{header.docLabel ?? "CPF"} {header.cpf} · {header.data}</Text>
            <Text style={s.sub}>Confidencial para {header.consultante} · Usuário {header.usuario}</Text>
            {header.endereco ? <Text style={s.sub}>{header.endereco}</Text> : null}
          </View>
          {smart?.parecer && (
            // paddingTop empurra o selo para baixo da chave do timbrado.
            <View style={{ width: 150, alignItems: "flex-end", paddingTop: 30 }}>
              <Text style={{ fontSize: 7, color: muted, marginBottom: 2 }}>Parecer de Cadastro</Text>
              <Text
                style={{
                  fontSize: 9,
                  fontFamily: "Helvetica-Bold",
                  color: "#fff",
                  backgroundColor: smart.parecer.aprovado ? "#2F9E44" : "#C92A2A",
                  paddingVertical: 3,
                  paddingHorizontal: 7,
                  borderRadius: 3,
                }}
              >
                {smart.parecer.aprovado ? "APROVADO" : "REPROVADO"}
              </Text>
              {smart.parecer.motivo ? (
                <Text style={{ fontSize: 7, color: muted, marginTop: 2, textAlign: "right" }}>
                  {smart.parecer.motivo}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {smart?.classificacao && (
          <Section title="Smart">
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 9 }}>
                Validade {dt(smart.classificacao.validade)}
                {smart.classificacao.pontuacaoAtingida != null
                  ? `   Pontuação atingida ${smart.classificacao.pontuacaoAtingida}`
                  : ""}
              </Text>
              <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{smart.classificacao.classificacao}</Text>
            </View>
            <SmartScale classificacao={smart.classificacao.classificacao} />

            {smart.parecer?.resultadoParecer && smart.parecer.resultadoParecer.length > 0 && (
              <>
                <Text style={s.sh}>Regras do parecer</Text>
                {smart.parecer.resultadoParecer.map((r, i) => (
                  <View key={i} style={{ marginBottom: 3 }} wrap={false}>
                    <Text style={s.li}>
                      <Text style={{ fontFamily: "Helvetica-Bold", color: r.atendido ? "#2F9E44" : "#C92A2A" }}>
                        {r.atendido ? "[OK] " : "[X] "}
                      </Text>
                      {r.nome}
                    </Text>
                    {(r.regras ?? []).map((g, j) => (
                      <Text key={j} style={[s.li, { marginLeft: 12, color: muted, fontSize: 7.5 }]}>
                        • {g.descricao}{g.resultado && g.resultado.length > 0 ? ` → ${g.resultado.join(", ")}` : ""}
                      </Text>
                    ))}
                  </View>
                ))}
              </>
            )}

            {smart.historicoClassificacao && smart.historicoClassificacao.length > 0 && (
              <>
                <Text style={s.sh}>Histórico de classificação</Text>
                <Table
                  cols={["Data", "Classificação"]}
                  widths={[0.5, 0.5]}
                  rows={smart.historicoClassificacao.map((h) => [
                    new Date(h.dataHora).toLocaleString("pt-BR"),
                    h.classificacao,
                  ])}
                />
              </>
            )}
          </Section>
        )}

        {score?.score != null && (
          <Section title="Score">
            {/* wrap={false}: número + legenda + barra ficam SEMPRE na mesma
                página (antes a barra se separava do número na quebra). */}
            <View wrap={false}>
              {/* height fixo reserva o espaço do número grande; sem isso a legenda
                  abaixo sobe por cima do número (linha baseline colapsa no react-pdf). */}
              <View style={{ flexDirection: "row", alignItems: "flex-end", height: 26 }}>
                <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: darkGreen, lineHeight: 1 }}>{score.score}</Text>
                <Text style={{ fontSize: 10, marginLeft: 8, marginBottom: 2, color: muted }}>{score.risco}</Text>
              </View>
              <Text style={{ fontSize: 7.5, color: muted, marginTop: 4 }}>
                Faixa de risco de crédito — quanto maior o score, menor o risco de inadimplência.
              </Text>
              <ScoreBar valor={score.score} />
            </View>
          </Section>
        )}

        {/* wrap={false}: título + cards nunca se separam; se não couber na
            página, o bloco inteiro vai para a próxima. */}
        <View style={s.section} wrap={false}>
          <Text style={s.h}>Restrições</Text>
          <Cards
            items={[
              { label: "Pendências", value: String(pendTotal) },
              { label: "Protestos", value: String(protestosTotal) },
              { label: "Ações judiciais", value: String(acoesTotal) },
              { label: "SCR risco total", value: brl(riscoTotal) },
            ]}
          />
        </View>

        {/* ── DADOS NA ÍNTEGRA — fluxo contínuo, sem quebra forçada ── */}
        <View style={[s.header, { marginTop: 22 }]} minPresenceAhead={90}>
          <Text style={[s.title, { color: teal }]}>Dados na íntegra</Text>
          <Text style={s.sub}>{header.name} · {header.docLabel ?? "CPF"} {header.cpf}</Text>
        </View>

        {pessoa && (
          <Section title="Identificação">
            <View style={s.grid}>
              <Field label="Situação cadastral" value={pessoa.situacaoCadastral ?? "—"} />
              <Field label="Data de nascimento" value={`${dt(pessoa.dataNascimento)}${pessoa.idade ? ` · ${pessoa.idade} anos` : ""}`} />
              <Field label="Nome da mãe" value={pessoa.nomeMae ?? "—"} />
              <Field label="Nacionalidade" value={pessoa.nacionalidade ?? "—"} />
              <Field label="Identidade" value={pessoa.identidade ?? "—"} />
              <Field label="Escolaridade" value={pessoa.escolaridade ?? "—"} />
              {pessoa.dadosCadastrais && (
                <>
                  <Field
                    label="Endereço"
                    value={[pessoa.dadosCadastrais.endereco, pessoa.dadosCadastrais.numero, pessoa.dadosCadastrais.complemento]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  />
                  <Field
                    label="Bairro / Cidade / UF"
                    value={[pessoa.dadosCadastrais.bairro, pessoa.dadosCadastrais.cidade, pessoa.dadosCadastrais.uf]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  />
                  <Field label="CEP" value={pessoa.dadosCadastrais.cep ?? "—"} />
                </>
              )}
            </View>
          </Section>
        )}

        {empresa && (
          <Section title="Identificação da empresa">
            <View style={s.grid}>
              <Field label="Razão social" value={empresa.razaoSocial ?? "—"} />
              <Field label="Nome fantasia" value={empresa.nomeFantasia || "—"} />
              <Field label="Situação cadastral" value={empresa.situacaoCadastral ?? "—"} />
              <Field label="Início de atividade" value={dt(empresa.dataInicioAtividade)} />
              <Field label="Natureza jurídica" value={empresa.naturezaJuridica ?? "—"} />
              <Field label="CNAE principal" value={empresa.cnaePrincipal ?? "—"} />
              <Field label="Porte" value={empresa.porte ?? "—"} />
              <Field label="Capital social" value={brl(empresa.capitalSocial)} />
              <Field label="NIRE" value={empresa.nire ?? "—"} />
              <Field label="Tipo de unidade" value={empresa.tipoUnidade ?? "—"} />
              <Field
                label="Endereço"
                value={[empresa.endereco, empresa.numero, empresa.complemento].filter(Boolean).join(", ") || "—"}
              />
              <Field
                label="Bairro / Cidade / UF"
                value={[empresa.bairro, empresa.municipio, empresa.uf].filter(Boolean).join(" · ") || "—"}
              />
              <Field label="CEP" value={empresa.cep ?? "—"} />
            </View>
            {empresa.cnaesSecundarios && empresa.cnaesSecundarios.length > 0 && (
              <>
                <Text style={s.sh}>CNAEs secundários</Text>
                {empresa.cnaesSecundarios.map((c, i) => (
                  <Text key={i} style={s.li}>• {c}</Text>
                ))}
              </>
            )}
          </Section>
        )}

        {score?.score != null && (
          <Section title="Score — faixas de risco">
            <Text style={{ fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 3 }}>
              {score.score} · {score.risco}
            </Text>
            {score.descricao ? <Text style={{ fontSize: 8, color: muted, marginBottom: 5 }}>{score.descricao}</Text> : null}
            <View style={{ marginTop: 2 }}>
              <View style={[s.tr, { backgroundColor: "#fff" }]}>
                <Text style={[s.th, { width: 0.3 * CONTENT_W }]}>Score</Text>
                <Text style={[s.th, { width: 0.7 * CONTENT_W }]}>Risco</Text>
              </View>
              {[
                { faixa: "300 a 553", risco: "Risco muito alto", color: "#C92A2A" },
                { faixa: "554 a 725", risco: "Risco alto", color: "#E8590C" },
                { faixa: "726 a 874", risco: "Risco médio", color: "#F08C00" },
                { faixa: "875 a 937", risco: "Risco baixo", color: "#5FB83D" },
                { faixa: "937 a 1000", risco: "Risco muito baixo", color: "#2F9E44" },
              ].map((b) => (
                <View key={b.faixa} style={s.tr} wrap={false}>
                  <Text style={[s.td, { width: 0.3 * CONTENT_W }]}>{b.faixa}</Text>
                  <Text style={[s.td, { width: 0.7 * CONTENT_W, color: b.color, fontFamily: "Helvetica-Bold" }]}>
                    {b.risco}
                  </Text>
                </View>
              ))}
            </View>
          </Section>
        )}

        {renda && (
          <Section title="Renda presumida">
            <Text style={{ fontSize: 9.5 }}>{renda.rendaPresumida ?? brl(renda.valorMinimo)}</Text>
          </Section>
        )}

        {faturamento && (
          <Section title="Faturamento presumido">
            <Text style={{ fontSize: 9.5 }}>
              {faturamento.faturamentoPresumido ?? brl(faturamento.valor)}
            </Text>
          </Section>
        )}

        {quadro && quadro.length > 0 && (
          <Section title="Quadro societário">
            <Table
              cols={["Nome", "Documento", "Cargo", "Part.", "Situação", "Entrada"]}
              widths={[0.3, 0.18, 0.16, 0.08, 0.14, 0.14]}
              rows={quadro.map((soc) => [
                soc.nome ?? "—",
                soc.documento ?? "—",
                soc.cargoSociedade ?? "—",
                soc.participacao != null ? `${soc.participacao}%` : "—",
                soc.situacao ?? "—",
                dt(soc.dataEntrada),
              ])}
            />
          </Section>
        )}

        {scr && (
          <Section title="SCR — Sistema de Informações de Crédito">
            {scr.vencimentosConsolidados?.informacaoConsulta && (
              <>
                <Text style={s.sh}>Resumo de dados</Text>
                <Table
                  cols={["Descrição", "Valor"]}
                  widths={[0.7, 0.3]}
                  rows={scr.vencimentosConsolidados.informacaoConsulta.map((i) => [i.descricao, i.valor])}
                />
              </>
            )}
            <ScrBlock block={scr.vencimentosConsolidados?.itensAVencer} />
            <ScrBlock block={scr.vencimentosConsolidados?.itensVencidos} />
            {scr.vencimentoPorModalidade && (
              <>
                <Text style={s.sh}>Vencimentos detalhados</Text>
                {scr.vencimentoPorModalidade.vencimentoPorModalidades?.map((m, i) => (
                  <ScrBlock key={`mod-${i}`} block={m} />
                ))}
                {/* Renderiza TODOS os demais blocos consolidados (Carteira Ativa A,
                    Prejuízo B, Carteira de crédito C, Repasses D, Coobrigação E,
                    Responsabilidade F, Créditos a liberar G, Limite H, Risco
                    Indireto I, garantidor, Risco Total…) — iteramos as chaves do
                    objeto, sem depender do nome de cada uma. */}
                {Object.entries(scr.vencimentoPorModalidade as Record<string, unknown>)
                  .filter(([k, v]) => k !== "vencimentoPorModalidades" && v != null && typeof v === "object" && !Array.isArray(v))
                  .map(([k, v]) => <ScrBlock key={k} block={v as ScrTotalBlock} />)}
              </>
            )}
          </Section>
        )}

        {mix.participacaoEmpresa?.data && mix.participacaoEmpresa.data.length > 0 && (
          <Section title="Participações em empresas">
            <Table
              cols={["CNPJ", "Nome", "Cargo", "Situação", "Entrada", "Atual.", "Part."]}
              widths={[0.18, 0.3, 0.1, 0.11, 0.1, 0.1, 0.07]}
              rows={mix.participacaoEmpresa.data.map((p) => [
                p.cnpj ?? "",
                p.nome ?? "",
                p.cargo ?? "",
                p.situacaoReceita ?? "",
                dt(p.dataEntrada),
                dt(p.dataUltimaAtualizacao),
                p.percentualParticipacao != null ? `${p.percentualParticipacao}%` : "",
              ])}
            />
          </Section>
        )}

        {mix.outrosEnderecos?.data && mix.outrosEnderecos.data.length > 0 && (
          <Section title="Outros endereços">
            <Table
              cols={["Logradouro", "Bairro", "Cidade/UF", "CEP"]}
              widths={[0.42, 0.24, 0.22, 0.12]}
              rows={mix.outrosEnderecos.data.map((e) => [
                [e.endereco, e.numero, e.complemento].filter(Boolean).join(", ") || "—",
                e.bairro ?? "—",
                e.municipio && e.uf ? `${e.municipio}/${e.uf}` : e.municipio ?? e.uf ?? "—",
                e.cep ?? "—",
              ])}
            />
          </Section>
        )}

        {mix.contatosPreferenciais?.data && mix.contatosPreferenciais.data.length > 0 && (
          <Section title="Contatos preferenciais">
            <Table
              cols={["Telefone", "Operadora", "WhatsApp"]}
              widths={[0.4, 0.4, 0.2]}
              rows={mix.contatosPreferenciais.data.map((c) => [c.telefone ?? "", c.operadora ?? "—", c.whatsapp ?? "Não"])}
            />
          </Section>
        )}

        {mix.emails?.data && mix.emails.data.length > 0 && (
          <Section title="E-mails">
            <Table
              cols={["E-mail"]}
              widths={[1]}
              rows={mix.emails.data.map((e) => [e])}
            />
          </Section>
        )}

        {mix.consultas?.data && (
          <Section title="Consultas anteriores">
            <Table
              cols={["Últimos 30d", "31-60d", "61-90d", "90d+"]}
              widths={[0.25, 0.25, 0.25, 0.25]}
              rows={[[
                mix.consultas.data.contagemUltimos30Dias ?? 0,
                mix.consultas.data.contagemUltimos31a60Dias ?? 0,
                mix.consultas.data.contagemUltimos61a90Dias ?? 0,
                mix.consultas.data.contagem90DiasMais ?? 0,
              ]]}
            />
            {mix.consultas.data.detalhes && mix.consultas.data.detalhes.length > 0 && (
              <>
                <Text style={s.sh}>Detalhes</Text>
                <Table
                  cols={["Data", "Segmento", "Quantidade"]}
                  widths={[0.34, 0.46, 0.2]}
                  rows={mix.consultas.data.detalhes.map((d) => [
                    dt(d.dataConsulta),
                    d.segmento ?? "—",
                    d.quantidadeConsultas ?? 0,
                  ])}
                />
              </>
            )}
          </Section>
        )}

        {mix.acoesJudiciais && (
          <Section title="Ações judiciais">
            {mix.acoesJudiciais.data?.ocorrencias && mix.acoesJudiciais.data.ocorrencias.length > 0 ? (
              <Table
                cols={["Ação", "Requerido", "Autor", "Vara / Comarca", "Processo", "Valor"]}
                widths={[0.12, 0.18, 0.2, 0.24, 0.16, 0.1]}
                rows={mix.acoesJudiciais.data.ocorrencias.map((o) => [
                  o.acao ?? "—",
                  o.requerido ?? "—",
                  o.autor ?? "—",
                  [o.vara, o.comarca && o.uf ? `${o.comarca}/${o.uf}` : o.comarca]
                    .filter(Boolean)
                    .join(" · ") || "—",
                  o.processo ?? "—",
                  brl(o.valor),
                ])}
              />
            ) : (
              <Text style={s.li}>{mix.acoesJudiciais.message ?? "Nada consta."}</Text>
            )}
          </Section>
        )}

        {mix.pendenciasRestricoes && (
          <Section title="Pendências e restrições">
            {(mix.pendenciasRestricoes.data?.ocorrencias?.length ?? 0) > 0 ? (
              <>
                <Text style={s.li}>
                  {[
                    mix.pendenciasRestricoes.data?.nivel,
                    mix.pendenciasRestricoes.data?.totalCredores != null
                      ? `${mix.pendenciasRestricoes.data.totalCredores} credor(es)`
                      : null,
                    mix.pendenciasRestricoes.data?.valor != null
                      ? `Total ${brl(mix.pendenciasRestricoes.data.valor)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                <Table
                  cols={["Informante", "Tipo", "Valor", "Data", "Contrato"]}
                  widths={[0.34, 0.15, 0.16, 0.14, 0.21]}
                  rows={(mix.pendenciasRestricoes.data?.ocorrencias ?? []).map((o) => [
                    o.informante ?? "—",
                    o.tipo ?? "—",
                    brl(o.valor),
                    dt(o.dataDebito),
                    o.numeroContrato ?? "—",
                  ])}
                />
              </>
            ) : (
              <Text style={s.li}>{mix.pendenciasRestricoes.message ?? "Nada consta."}</Text>
            )}
          </Section>
        )}

        {mix.protestos && (
          <Section title="Protestos">
            {protestosTotal > 0 ? (
              <>
                <Text style={s.li}>
                  {protestosTotal} ocorrência(s)
                  {protestosResumo.valorTotal != null
                    ? ` · Total ${brl(protestosResumo.valorTotal)}`
                    : ""}
                </Text>
                {protestosResumo.ocorrencias.length > 0 && (
                  <Table
                    cols={["Cartório", "UF", "Data", "Valor"]}
                    widths={[0.56, 0.08, 0.16, 0.2]}
                    rows={protestosResumo.ocorrencias.map((o) => [
                      o.cartorio ?? "—",
                      o.uf ?? "—",
                      dt(o.data),
                      brl(o.valor),
                    ])}
                  />
                )}
              </>
            ) : (
              <Text style={s.li}>{mix.protestos.message ?? "Nada consta."}</Text>
            )}
          </Section>
        )}

        {mix.restricoesCheques && (
          <Section title="Restrições de cheques">
            <Text style={s.li}>Devolvidos sem fundo: {mix.restricoesCheques.chequesDevolvidosSemFundo?.message ?? "Nada consta."}</Text>
            <Text style={s.li}>Devolvidos outros motivos: {mix.restricoesCheques.chequesDevolvidosOutrosMotivos?.message ?? "Nada consta."}</Text>
          </Section>
        )}

        {/* Pontos da política Smart — ao final da pesquisa, antes do parecer de IA. */}
        {smart && ((smart.positivas?.length ?? 0) > 0 || (smart.negativas?.length ?? 0) > 0) && (
          <Section title="Pontos positivos e negativos (política Smart)">
            <View style={{ flexDirection: "row" }} wrap={false}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={[s.sh, { color: "#2F9E44" }]}>Pontos positivos</Text>
                {(smart.positivas ?? []).length === 0 ? (
                  <Text style={s.li}>—</Text>
                ) : (
                  (smart.positivas ?? []).map((m, i) => (
                    <Text key={i} style={s.li}>{m.metrica} — {m.descricao} (Pol. {m.impacto}% · Mét. {m.percentualMetrica}% · {m.pontuacao > 0 ? "+" : ""}{m.pontuacao} pts)</Text>
                  ))
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.sh, { color: "#C92A2A" }]}>Pontos negativos</Text>
                {(smart.negativas ?? []).length === 0 ? (
                  <Text style={s.li}>—</Text>
                ) : (
                  (smart.negativas ?? []).map((m, i) => (
                    <Text key={i} style={s.li}>{m.metrica} — {m.descricao} (Pol. {m.impacto}% · Mét. {m.percentualMetrica}% · {m.pontuacao} pts)</Text>
                  ))
                )}
              </View>
            </View>
          </Section>
        )}

        {/* Parecer de IA — sempre por último. */}
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
  mix: PfMix,
  header: FullPdfHeader,
  letterhead: string,
  opinion?: OpinionForPdf | null
): Promise<Buffer> {
  return renderToBuffer(
    <FullDocument mix={mix} header={header} letterhead={letterhead} opinion={opinion} />
  );
}
