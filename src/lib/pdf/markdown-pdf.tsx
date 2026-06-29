import type { ReactNode } from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";

// Renderizador de parecer de IA compartilhado pelos dois PDFs (PF rico e PJ
// simples). Inclui o conversor markdown→react-pdf (títulos, listas, **negrito**,
// tabelas) e o bloco de decisão (selo APTO + perfil + limite).

const teal = "#0F6E6E";
const gold = "#9A6A00";
const slate = "#475569";
const muted = "#6b7280";
const border = "#e5e7eb";
const A4_W = 595.28;
const PAD_X = 42;
const CONTENT_W = A4_W - PAD_X * 2;

const brl = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);

const APTITUDE_META: Record<string, { label: string; color: string }> = {
  apt: { label: "APTO", color: "#2F9E44" },
  apt_with_caveats: { label: "APTO COM RESSALVAS", color: "#F08C00" },
  inapt: { label: "INAPTO", color: "#C92A2A" },
};

const m = StyleSheet.create({
  h: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    color: teal,
    marginTop: 8,
    marginBottom: 5,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: border,
  },
  sh: { fontSize: 9.5, fontFamily: "Helvetica-Bold", color: gold, marginTop: 6, marginBottom: 3 },
  ssh: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: slate, marginTop: 4, marginBottom: 2 },
  li: { fontSize: 8, marginBottom: 2, lineHeight: 1.3 },
  p: { fontSize: 8, marginBottom: 3, lineHeight: 1.3 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: border, paddingVertical: 3 },
  th: { fontSize: 7, fontFamily: "Helvetica-Bold", color: muted },
  td: { fontSize: 7.5, lineHeight: 1.25 },
  badge: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "#fff",
    paddingVertical: 3.5,
    paddingHorizontal: 8,
    borderRadius: 3,
  },
});

function MdTable({ cols, rows }: { cols: string[]; rows: string[][] }) {
  const w = CONTENT_W / cols.length;
  return (
    <View style={{ marginTop: 3 }} minPresenceAhead={24}>
      <View style={[m.tr, { backgroundColor: "#fff" }]} fixed>
        {cols.map((c, i) => (
          <Text key={i} style={[m.th, { width: w }]}>
            {c}
          </Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} style={m.tr} wrap={false}>
          {r.map((cell, ci) => (
            <Text key={ci} style={[m.td, { width: w }]}>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function mdInline(text: string, keyBase: string): ReactNode[] {
  return text
    .replace(/`/g, "")
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((p) => p !== "")
    .map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <Text key={`${keyBase}-${i}`} style={{ fontFamily: "Helvetica-Bold" }}>
          {p.slice(2, -2)}
        </Text>
      ) : (
        <Text key={`${keyBase}-${i}`}>{p}</Text>
      )
    );
}

export function MarkdownPdf({ md }: { md: string }) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const splitRow = (r: string) =>
    r
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim().replace(/\*\*/g, ""));

  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }

    // Tabela: "| ... |" seguida de separador "|---|".
    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^[\s|:-]+$/.test(lines[i + 1].trim()) &&
      lines[i + 1].includes("-")
    ) {
      const cols = splitRow(lines[i]);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitRow(lines[i]);
        while (cells.length < cols.length) cells.push("");
        body.push(cells.slice(0, cols.length));
        i++;
      }
      out.push(<MdTable key={`t-${k++}`} cols={cols} rows={body} />);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // Cores por nível: # = seção (teal) · ## = subtítulo (dourado) · ###+ = ardósia.
      const lvl = h[1].length;
      const style = lvl <= 1 ? m.h : lvl === 2 ? m.sh : m.ssh;
      out.push(
        <Text key={`h-${k++}`} style={style} wrap={false}>
          {h[2].replace(/\*\*/g, "")}
        </Text>
      );
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      i++;
      continue;
    }

    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      out.push(
        <Text key={`b-${k}`} style={[m.li, { marginLeft: 8 }]}>
          • {mdInline(b[1], `b${k++}`)}
        </Text>
      );
      i++;
      continue;
    }

    out.push(
      <Text key={`p-${k}`} style={m.p}>
        {mdInline(line, `p${k++}`)}
      </Text>
    );
    i++;
  }

  return <>{out}</>;
}

// Parecer de IA (ai_reports) renderizado nos PDFs.
export interface OpinionForPdf {
  aptitude: "apt" | "apt_with_caveats" | "inapt" | string | null;
  classificacao?: string | null;
  resumo?: string | null;
  pontosFortes: { title: string; description: string }[];
  pontosAtencao: { title: string; description: string; severity?: string | null }[];
  planoAcao: { step: string; description: string; priority?: string | null }[];
  limiteSugerido?: number | null;
  limiteNotas?: string | null;
  modelo?: string | null;
  // Parecer técnico completo (markdown das 23 seções). Quando presente, é
  // renderizado na íntegra no lugar do resumo estruturado.
  relatorioMarkdown?: string | null;
}

// Bloco completo do parecer: selo de decisão + relatório completo (ou resumo
// estruturado como fallback) + rodapé do modelo. Wrappável (pagina sozinho).
export function OpinionBlock({ opinion }: { opinion: OpinionForPdf }) {
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
        <Text
          style={[
            m.badge,
            { backgroundColor: APTITUDE_META[opinion.aptitude ?? ""]?.color ?? muted },
          ]}
        >
          {APTITUDE_META[opinion.aptitude ?? ""]?.label ?? "—"}
        </Text>
        {opinion.classificacao ? (
          <Text style={{ fontSize: 9, marginLeft: 8 }}>Perfil: {opinion.classificacao}</Text>
        ) : null}
        {opinion.limiteSugerido != null ? (
          <Text style={{ fontSize: 9, marginLeft: 8 }}>
            Limite sugerido <Text style={{ fontFamily: "Helvetica-Bold" }}>{brl(opinion.limiteSugerido)}</Text>
          </Text>
        ) : null}
      </View>

      {opinion.relatorioMarkdown ? (
        <View style={{ marginTop: 6 }}>
          <MarkdownPdf md={opinion.relatorioMarkdown} />
        </View>
      ) : (
        <>
          {opinion.resumo ? <Text style={[m.li, { marginTop: 6 }]}>{opinion.resumo}</Text> : null}
          {opinion.pontosFortes.length > 0 && (
            <>
              <Text style={[m.sh, { color: "#2F9E44" }]}>Pontos fortes</Text>
              {opinion.pontosFortes.map((p, i) => (
                <Text key={i} style={m.li}>
                  <Text style={{ fontFamily: "Helvetica-Bold" }}>{p.title}</Text>
                  {p.description ? ` — ${p.description}` : ""}
                </Text>
              ))}
            </>
          )}
          {opinion.pontosAtencao.length > 0 && (
            <>
              <Text style={[m.sh, { color: "#C92A2A" }]}>Pontos de atenção</Text>
              {opinion.pontosAtencao.map((p, i) => (
                <Text key={i} style={m.li}>
                  <Text style={{ fontFamily: "Helvetica-Bold" }}>{p.title}</Text>
                  {p.severity ? ` (${p.severity})` : ""}
                  {p.description ? ` — ${p.description}` : ""}
                </Text>
              ))}
            </>
          )}
          {opinion.planoAcao.length > 0 && (
            <>
              <Text style={m.sh}>Plano de ação</Text>
              {opinion.planoAcao.map((a, i) => (
                <Text key={i} style={m.li}>
                  {i + 1}. <Text style={{ fontFamily: "Helvetica-Bold" }}>{a.step}</Text>
                  {a.priority ? ` [${a.priority}]` : ""}
                  {a.description ? ` — ${a.description}` : ""}
                </Text>
              ))}
            </>
          )}
          {opinion.limiteNotas ? (
            <Text style={[m.li, { marginTop: 4, color: muted }]}>{opinion.limiteNotas}</Text>
          ) : null}
        </>
      )}

      {opinion.modelo ? (
        <Text style={{ fontSize: 7, color: muted, marginTop: 6 }}>
          Gerado por IA ({opinion.modelo}). Sujeito a validação humana.
        </Text>
      ) : null}
    </View>
  );
}
