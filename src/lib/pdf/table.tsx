import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "./fonts";
import {
  CELL_PADDING,
  chunkRows,
  columnLayout,
  dropEmptyColumns,
  estimateRowHeight,
  inferColumnType,
  keepMoneyTogether,
  valueMinWidth,
  type ColumnType,
} from "./table-layout";
import { PDF_COLORS, PDF_PAGE, PDF_ROW_HEIGHT, PDF_TYPE } from "./theme";

export interface PdfTableColumn {
  label: string;
  type?: ColumnType;
}

export interface PdfTableRow {
  cells: string[];
  kind?: "normal" | "subtotal";
  level?: 0 | 1 | 2;
  // Linha de título de grupo: ocupa a largura toda no lugar das células e abre uma nova faixa de zebra.
  heading?: ReactNode;
  // Conteúdo sob a linha (registros aninhados). O bloco que o contém pode quebrar de página.
  extra?: ReactNode;
}

const LEVEL_INDENT = 12;
const USABLE_HEIGHT = PDF_PAGE.height - PDF_PAGE.paddingTop - PDF_PAGE.paddingBottom;
// Um quarto de página por bloco: a perda por bloco que não coube fica abaixo de 25% da área útil.
const ROWS_PER_CHUNK = Math.floor(USABLE_HEIGHT / PDF_ROW_HEIGHT / 4);
// O primeiro bloco é curto: o título que o antecede só reserva espaço para ele (cabeçalho + 4 linhas).
const FIRST_CHUNK_ROWS = 4;
// Linha mais alta que um quarto de página forma o próprio bloco; bloco acima de 80% da área útil pode quebrar de página.
const TALL_ROW_HEIGHT = USABLE_HEIGHT / 4;
const MAX_UNBREAKABLE_HEIGHT = USABLE_HEIGHT * 0.8;
// A linha-pai de um conteúdo aninhado não fica sozinha no fim da página: exige este espaço depois dela.
const PARENT_KEEP_WITH_NEXT = 60;
// Largura útil de um campo da grade de duas colunas (metade do conteúdo menos o respiro à direita).
const FIELD_WIDTH = PDF_PAGE.contentWidth / 2 - 8;

const st = StyleSheet.create({
  noShrink: { flexShrink: 0 },
  spacer: { height: 0 },
  // Folga de 2 pt: o react-pdf mede o último texto de um bloco que quebra um pouco abaixo do que desenha.
  extraBox: { flexShrink: 0, paddingBottom: 2 },
  title: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.body, color: PDF_COLORS.green, marginTop: 6, marginBottom: 3 },
  headRow: { flexDirection: "row", borderBottomWidth: 0.75, borderBottomColor: PDF_COLORS.rule, paddingVertical: 3 },
  th: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.tableHeader, color: PDF_COLORS.muted, textTransform: "uppercase" },
  row: { flexDirection: "row", flexShrink: 0, minHeight: PDF_ROW_HEIGHT, paddingVertical: 3.6 },
  td: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.ink, lineHeight: 1.2 },
  bold: { fontFamily: PDF_FONT_FAMILY_BOLD },
  fieldBox: { width: "50%", marginBottom: 5, paddingRight: 8 },
  fieldLabel: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted },
  fieldValue: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, lineHeight: 1.3 },
});

type Layout = ReturnType<typeof columnLayout>;

// O texto da primeira e da última coluna encosta nas margens do conteúdo; entre colunas há respiro.
const cellPad = (i: number, last: number) => ({ paddingLeft: i === 0 ? 0 : CELL_PADDING, paddingRight: i === last ? 0 : CELL_PADDING });

function Head({ columns, layout, title }: { columns: PdfTableColumn[]; layout: Layout; title?: string }) {
  return (
    <View>
      {title ? <Text style={st.title}>{title}</Text> : null}
      <View style={st.headRow}>
        {columns.map((column, i) => (
          <Text key={i} style={[st.th, cellPad(i, layout.length - 1), { width: layout[i].width, textAlign: layout[i].align }]}>
            {column.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Row({ row, layout, types, zebra, tall }: { row: PdfTableRow; layout: Layout; types: ColumnType[]; zebra: boolean; tall: boolean }) {
  const bold = row.kind === "subtotal";
  if (row.heading) {
    return (
      <View style={st.noShrink}>
        {row.heading}
        {row.extra}
      </View>
    );
  }
  const line = (
    <View
      style={[st.row, zebra ? { backgroundColor: PDF_COLORS.zebra } : {}]}
      wrap={tall}
      minPresenceAhead={row.extra ? PARENT_KEEP_WITH_NEXT : undefined}
    >
      {layout.map((col, i) => (
        <Text
          key={i}
          style={[st.td, cellPad(i, layout.length - 1), bold ? st.bold : {}, { width: col.width, textAlign: col.align }, i === 0 ? { paddingLeft: (row.level ?? 0) * LEVEL_INDENT } : {}]}
        >
          {types[i] === "money" ? keepMoneyTogether(row.cells[i] ?? "") : (row.cells[i] ?? "")}
        </Text>
      ))}
    </View>
  );
  // Linha sem conteúdo aninhado não ganha View de embrulho: menos nós por linha, layout mais rápido em tabela longa.
  if (!row.extra) return line;
  return (
    <View style={st.noShrink}>
      {/* O react-pdf só aplica minPresenceAhead a quem tem irmão antes; sem este, a linha-pai que abre o bloco ignora a regra. */}
      <View style={st.spacer} />
      {line}
      <View style={st.extraBox}>{row.extra}</View>
    </View>
  );
}

// Tabela padrão. O react-pdf não repete cabeçalho: as linhas saem em blocos que não quebram, cada um com
// seu cabeçalho. O cabeçalho do bloco só desenha quando o bloco abre uma página nova (a página é lida
// na hora do layout); assim dois blocos na mesma página formam uma tabela só.
export function PdfTable({
  columns,
  rows,
  title,
  indent = 0,
}: {
  columns: PdfTableColumn[];
  rows: PdfTableRow[];
  title?: string;
  indent?: number;
}) {
  const kept = dropEmptyColumns(columns, rows.map((row) => row.cells));
  if (rows.length === 0) return null;
  // Todas as colunas vazias: só o conteúdo aninhado sobra.
  if (kept.columns.length === 0) {
    return (
      <>
        {rows.map((row, i) =>
          row.heading || row.extra ? (
            <View key={i}>
              {row.heading}
              {row.extra}
            </View>
          ) : null,
        )}
      </>
    );
  }
  const cells = kept.rows;
  const data = rows.map((row, i) => ({ ...row, cells: cells[i] }));
  const types = kept.columns.map((column, i) => column.type ?? inferColumnType(column.label, cells.map((r) => r[i])));
  const minWidths = types.map((type, i) => (type === "text" ? 0 : valueMinWidth(cells.map((r) => r[i]))));
  const layout = columnLayout(types, PDF_PAGE.contentWidth - indent, kept.columns.map((column) => column.label), minWidths);
  const widths = layout.map((col) => col.width);
  const heights = data.map((row) => (row.heading ? 0 : estimateRowHeight(row.cells, widths)));
  const heightOf = new Map(data.map((row, i) => [row, heights[i]]));
  const chunks = chunkRows(
    data,
    FIRST_CHUNK_ROWS,
    ROWS_PER_CHUNK,
    (row) => row.heading !== undefined,
    (row) => row.extra !== undefined || (heightOf.get(row) ?? 0) > TALL_ROW_HEIGHT,
  );
  // Zebra por faixa: recomeça a cada título de grupo.
  let run = 0;
  const zebra = data.map((row) => {
    if (row.heading) run = 0;
    else run += 1;
    return !row.heading && run % 2 === 0;
  });
  const pageOfChunk: number[] = [];
  let offset = 0;
  return (
    <View style={[st.noShrink, { marginLeft: indent }]}>
      {chunks.map((chunk, k) => {
        const first = offset;
        offset += chunk.length;
        const headTitle = k === 0 || !title ? title : `${title} (continuação)`;
        // Bloco com conteúdo aninhado ou alto demais para uma página quebra entre linhas; os demais ficam inteiros.
        // `wrap` precisa ser booleano explícito: `wrap={undefined}` desliga a quebra no react-pdf (e espremia o bloco).
        const breakable =
          chunk.some((row) => row.extra) || chunk.reduce((sum, row) => sum + (heightOf.get(row) ?? 0), 0) > MAX_UNBREAKABLE_HEIGHT;
        return (
          <View key={k} wrap={breakable} style={st.noShrink}>
            {breakable ? <View style={st.spacer} /> : null}
            <View
              minPresenceAhead={breakable ? PARENT_KEEP_WITH_NEXT : undefined}
              render={({ pageNumber }) => {
                pageOfChunk[k] = pageNumber;
                return k === 0 || pageOfChunk[k - 1] !== pageNumber ? (
                  <Head columns={kept.columns} layout={layout} title={headTitle} />
                ) : null;
              }}
            />
            {chunk.map((row, i) => (
              <Row key={first + i} row={row} layout={layout} types={types} zebra={zebra[first + i]} tall={(heightOf.get(row) ?? 0) > TALL_ROW_HEIGHT} />
            ))}
            {breakable ? (
              <View
                render={({ pageNumber }) => {
                  pageOfChunk[k] = pageNumber; // o bloco pode terminar em outra página que a que abriu
                  return null;
                }}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// Campos rótulo/valor em grade de duas colunas.
export function PdfFields({ fields }: { fields: { label: string; value: string }[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {fields.map((field, i) => (
        <View key={i} style={st.fieldBox} wrap={estimateRowHeight([field.value], [FIELD_WIDTH], PDF_TYPE.body) > MAX_UNBREAKABLE_HEIGHT}>
          <Text style={st.fieldLabel}>{field.label}</Text>
          <Text style={st.fieldValue}>{field.value || "—"}</Text>
        </View>
      ))}
    </View>
  );
}
