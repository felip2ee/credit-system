import type { ReactNode } from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";

import { STATE_COLORS } from "@/lib/brand/tokens";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "./fonts";
import { PdfTable } from "./table";
import { PDF_COLORS, PDF_TYPE } from "./theme";

// Renderizador de parecer de IA compartilhado pelos dois PDFs (PF rico e PJ
// simples). Inclui o conversor markdown→react-pdf (títulos, listas, **negrito**,
// tabelas) e o bloco de decisão (selo APTO + perfil + limite + parecer).

const brl = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);

const APTITUDE_META: Record<string, { label: string; color: string }> = {
  apt: { label: "APTO", color: STATE_COLORS.success.border },
  apt_with_caveats: { label: "APTO COM RESSALVAS", color: STATE_COLORS.attention.border },
  inapt: { label: "INAPTO", color: STATE_COLORS.danger.border },
};

const LINE_HEIGHT = 1.45;

const m = StyleSheet.create({
  // Título de seção: filete dourado curto acima, texto verde.
  sectionRule: { width: 26, height: 1.5, backgroundColor: PDF_COLORS.goldRule, marginTop: 14, marginBottom: 5 },
  sectionTitle: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.section, color: PDF_COLORS.green, marginBottom: 5 },
  sub: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.body, color: PDF_COLORS.goldText, marginTop: 8, marginBottom: 3 },
  subMuted: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.body, color: PDF_COLORS.muted, marginTop: 6, marginBottom: 2 },
  text: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, lineHeight: LINE_HEIGHT },
  p: { marginBottom: 5 },
  bold: { fontFamily: PDF_FONT_FAMILY_BOLD },
  muted: { color: PDF_COLORS.muted },
  item: { flexDirection: "row", marginBottom: 3, paddingLeft: 4 },
  marker: { width: 14 },
  itemBody: { flex: 1 },
  badge: {
    fontFamily: PDF_FONT_FAMILY_BOLD,
    fontSize: PDF_TYPE.table,
    color: "#fff",
    paddingVertical: 3.5,
    paddingHorizontal: 8,
    borderRadius: 2,
  },
});

function mdInline(text: string, keyBase: string): ReactNode[] {
  return text
    .replace(/`/g, "")
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((p) => p !== "")
    .map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <Text key={`${keyBase}-${i}`} style={m.bold}>
          {p.slice(2, -2)}
        </Text>
      ) : (
        <Text key={`${keyBase}-${i}`}>{p}</Text>
      )
    );
}

// Item de lista: marcador fixo + corpo que quebra dentro da própria coluna.
function ListItem({ marker, children }: { marker: string; children: ReactNode }) {
  return (
    <View style={m.item} wrap={false}>
      <Text style={[m.text, m.marker]}>{marker}</Text>
      <Text style={[m.text, m.itemBody]}>{children}</Text>
    </View>
  );
}

// Seção do parecer: o título fica junto do primeiro item (o react-pdf ignora minPresenceAhead).
function Section({ title, items }: { title: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <View>
      <View wrap={false}>
        <View style={m.sectionRule} />
        <Text style={m.sectionTitle}>{title}</Text>
        {items[0]}
      </View>
      {items.slice(1)}
    </View>
  );
}

const splitRow = (r: string): string[] =>
  r
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim().replace(/\*\*/g, ""));

interface MdBlock {
  node: ReactNode;
  kind: "heading" | "table" | "text";
}

function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
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
      const rows: { cells: string[] }[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitRow(lines[i]);
        while (cells.length < cols.length) cells.push("");
        rows.push({ cells: cells.slice(0, cols.length) });
        i++;
      }
      blocks.push({
        node: <PdfTable key={`t-${k++}`} columns={cols.map((label) => ({ label }))} rows={rows} />,
        kind: "table",
      });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // # = seção (verde, filete dourado) · ## = subtítulo (dourado) · ###+ = discreto.
      const level = h[1].length;
      const text = h[2].replace(/\*\*/g, "");
      const node =
        level === 1 ? (
          <View key={`h-${k++}`}>
            <View style={m.sectionRule} />
            <Text style={m.sectionTitle}>{text}</Text>
          </View>
        ) : (
          <Text key={`h-${k++}`} style={level === 2 ? m.sub : m.subMuted}>
            {text}
          </Text>
        );
      blocks.push({ node, kind: "heading" });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      i++;
      continue;
    }

    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      blocks.push({ node: <ListItem key={`b-${k}`} marker="•">{mdInline(b[1], `b${k++}`)}</ListItem>, kind: "text" });
      i++;
      continue;
    }

    blocks.push({
      node: (
        <Text key={`p-${k}`} style={[m.text, m.p]}>
          {mdInline(line, `p${k++}`)}
        </Text>
      ),
      kind: "text",
    });
    i++;
  }
  return blocks;
}

export function MarkdownPdf({ md }: { md: string }) {
  const blocks = parseMarkdown(md);
  const out: ReactNode[] = [];
  for (let n = 0; n < blocks.length; n++) {
    const block = blocks[n];
    const next = blocks[n + 1];
    // Título nunca fica sozinho no fim da página: vai junto do bloco seguinte (exceto tabela, que pode ser longa).
    if (block.kind === "heading" && next && next.kind !== "table") {
      out.push(
        <View key={`g-${n}`} wrap={false}>
          {block.node}
          {next.node}
        </View>
      );
      n++;
    } else {
      out.push(block.node);
    }
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
  // Parecer técnico completo (markdown das 23 seções). Impresso depois dos campos estruturados.
  relatorioMarkdown?: string | null;
}

const dash = (description: string): string => (description ? ` — ${description}` : "");

// Bloco completo do parecer, na ordem: selo e perfil, limite e notas, resumo, pontos fortes,
// pontos de atenção, plano de ação, relatório. Imprime só o que existe. Wrappável.
export function OpinionBlock({ opinion }: { opinion: OpinionForPdf }) {
  const meta = APTITUDE_META[opinion.aptitude ?? ""];
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
        <Text style={[m.badge, { backgroundColor: meta?.color ?? PDF_COLORS.muted }]}>{meta?.label ?? "—"}</Text>
        {opinion.classificacao ? (
          <Text style={[m.text, { marginLeft: 10 }]}>
            <Text style={m.muted}>Perfil </Text>
            <Text style={m.bold}>{opinion.classificacao}</Text>
          </Text>
        ) : null}
      </View>

      {opinion.limiteSugerido != null || opinion.limiteNotas ? (
        <View style={{ marginTop: 8 }}>
          {opinion.limiteSugerido != null ? (
            <Text style={m.text}>
              <Text style={m.muted}>Limite sugerido </Text>
              <Text style={m.bold}>{brl(opinion.limiteSugerido)}</Text>
            </Text>
          ) : null}
          {opinion.limiteNotas ? <Text style={[m.text, m.muted]}>{opinion.limiteNotas}</Text> : null}
        </View>
      ) : null}

      <Section title="Resumo" items={opinion.resumo ? [<Text key="r" style={m.text}>{opinion.resumo}</Text>] : []} />
      <Section
        title="Pontos fortes"
        items={opinion.pontosFortes.map((p, i) => (
          <ListItem key={i} marker="•">
            <Text style={m.bold}>{p.title}</Text>
            {dash(p.description)}
          </ListItem>
        ))}
      />
      <Section
        title="Pontos de atenção"
        items={opinion.pontosAtencao.map((p, i) => (
          <ListItem key={i} marker="•">
            <Text style={m.bold}>{p.title}</Text>
            {p.severity ? ` (${p.severity})` : ""}
            {dash(p.description)}
          </ListItem>
        ))}
      />
      <Section
        title="Plano de ação"
        items={opinion.planoAcao.map((a, i) => (
          <ListItem key={i} marker={`${i + 1}.`}>
            <Text style={m.bold}>{a.step}</Text>
            {a.priority ? ` [${a.priority}]` : ""}
            {dash(a.description)}
          </ListItem>
        ))}
      />

      {opinion.relatorioMarkdown ? (
        <View style={{ marginTop: 4 }}>
          <MarkdownPdf md={opinion.relatorioMarkdown} />
        </View>
      ) : null}

      {opinion.modelo ? (
        <Text style={[m.text, m.muted, { fontSize: PDF_TYPE.table, marginTop: 10 }]}>
          Gerado por IA ({opinion.modelo}). Sujeito a validação humana.
        </Text>
      ) : null}
    </View>
  );
}
