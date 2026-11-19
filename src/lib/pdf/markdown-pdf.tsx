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
// Até este tamanho (≈ 8 linhas) um bloco não quebra entre páginas; acima disso ele quebra, para nunca passar da página.
const SHORT_BLOCK_CHARS = 700;
// Espaço que um título exige abaixo de si quando o bloco seguinte é longo ou é tabela.
const HEADING_AHEAD = 70;

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

// Item de lista: marcador fixo + corpo que quebra dentro da própria coluna. Item longo (`chars`) pode quebrar entre páginas.
function ListItem({ marker, chars, children }: { marker: string; chars: number; children: ReactNode }) {
  return (
    <View style={m.item} wrap={chars > SHORT_BLOCK_CHARS}>
      <Text style={[m.text, m.marker]}>{marker}</Text>
      <Text style={[m.text, m.itemBody]}>{children}</Text>
    </View>
  );
}

// Seção do parecer: o título é irmão dos itens e só fica na página se couber o começo do primeiro item
// (agrupar título e item num bloco que não quebra estoura a página quando o item é longo).
function Section({ title, items }: { title: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <View>
      <View wrap={false} minPresenceAhead={HEADING_AHEAD}>
        <View style={m.sectionRule} />
        <Text style={m.sectionTitle}>{title}</Text>
      </View>
      {items}
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
  // Tamanho do texto, para estimar se o bloco cabe junto do título sem ficar mais alto que a página.
  chars: number;
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
      const parsed: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        parsed.push(splitRow(lines[i]));
        i++;
      }
      // A tabela tem tantas colunas quanto a linha mais larga: nenhuma célula some (rótulos extras ficam vazios).
      const width = Math.max(cols.length, ...parsed.map((cells) => cells.length));
      const labels = [...cols, ...Array<string>(width - cols.length).fill("")];
      const rows = parsed.map((cells) => ({ cells: [...cells, ...Array<string>(width - cells.length).fill("")] }));
      blocks.push({
        node: <PdfTable key={`t-${k++}`} columns={labels.map((label) => ({ label }))} rows={rows} />,
        kind: "table",
        chars: 0,
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
      blocks.push({ node, kind: "heading", chars: text.length });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      i++;
      continue;
    }

    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      blocks.push({ node: <ListItem key={`b-${k}`} marker="•" chars={b[1].length}>{mdInline(b[1], `b${k++}`)}</ListItem>, kind: "text", chars: b[1].length });
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
      chars: line.length,
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
    if (block.kind !== "heading") {
      out.push(block.node);
      continue;
    }
    // Título curto + bloco curto: um grupo que não quebra. Bloco longo ou tabela: o grupo passaria da página
    // (o react-pdf não o quebra), então o título é irmão do bloco e só fica na página se couberem ao menos
    // HEADING_AHEAD pt do que vem depois (minPresenceAhead vale em View, não em Text).
    if (next && next.kind === "text" && next.chars <= SHORT_BLOCK_CHARS) {
      out.push(
        <View key={`g-${n}`} wrap={false}>
          {block.node}
          {next.node}
        </View>
      );
      n++;
    } else {
      out.push(
        <View key={`g-${n}`} wrap={false} minPresenceAhead={HEADING_AHEAD}>
          {block.node}
        </View>
      );
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
        <Text style={[m.badge, { backgroundColor: meta?.color ?? PDF_COLORS.muted }]}>{meta?.label ?? opinion.aptitude ?? "—"}</Text>
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
          <ListItem key={i} marker="•" chars={p.title.length + p.description.length}>
            <Text style={m.bold}>{p.title}</Text>
            {dash(p.description)}
          </ListItem>
        ))}
      />
      <Section
        title="Pontos de atenção"
        items={opinion.pontosAtencao.map((p, i) => (
          <ListItem key={i} marker="•" chars={p.title.length + p.description.length}>
            <Text style={m.bold}>{p.title}</Text>
            {p.severity ? ` (${p.severity})` : ""}
            {dash(p.description)}
          </ListItem>
        ))}
      />
      <Section
        title="Plano de ação"
        items={opinion.planoAcao.map((a, i) => (
          <ListItem key={i} marker={`${i + 1}.`} chars={a.step.length + a.description.length}>
            <Text style={m.bold}>{a.step}</Text>
            {a.priority ? ` [${a.priority}]` : ""}
            {dash(a.description)}
          </ListItem>
        ))}
      />

      {/* Sem View em volta: o título precisa ter irmãos anteriores para o minPresenceAhead valer. */}
      {opinion.relatorioMarkdown ? <MarkdownPdf md={opinion.relatorioMarkdown} /> : null}

      {opinion.modelo ? (
        <Text style={[m.text, m.muted, { fontSize: PDF_TYPE.table, marginTop: 10 }]}>
          Gerado por IA ({opinion.modelo}). Sujeito a validação humana.
        </Text>
      ) : null}
    </View>
  );
}
