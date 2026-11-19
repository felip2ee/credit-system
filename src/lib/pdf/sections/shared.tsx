import { StyleSheet, Text, View } from "@react-pdf/renderer";
import { Fragment, type ReactNode } from "react";

import type { GenericBlock, GenericValue, SectionPart } from "@/types/consultation-view";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PdfGenericValue } from "../generic-block";
import { PDF_COLORS, PDF_TYPE } from "../theme";

// Espaço que um título exige abaixo de si na mesma página, conforme o que vem depois. Para tabela é o primeiro
// bloco (título, cabeçalho e 4 linhas de 18 pt, com folga); menos que isso deixaria o título sozinho se o bloco pular.
export const FIRST_BLOCK = 120;
const TEXT_BLOCK = 32;

export function reserveFor(value: GenericValue): number {
  switch (value.kind) {
    case "table":
      return FIRST_BLOCK;
    case "fields": {
      const first = value.fields[0];
      return first && first.value.kind !== "text" ? 20 + reserveFor(first.value) : TEXT_BLOCK + 8;
    }
    default:
      return TEXT_BLOCK;
  }
}

const st = StyleSheet.create({
  rule: { width: 18, height: 2, backgroundColor: PDF_COLORS.goldRule, marginBottom: 5 },
  section: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.section, color: PDF_COLORS.green, marginBottom: 7 },
  part: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.body, color: PDF_COLORS.ink, marginTop: 8, marginBottom: 3 },
  note: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.table, color: PDF_COLORS.muted, marginBottom: 3 },
});

// Mantém o título com o que vem depois: o bloco não quebra e só fica na página se houver `reserve` pt
// de irmãos seguintes ali (o react-pdf ignora `minPresenceAhead` em Text, mas respeita em View).
export function Lead({ reserve, top = 0, children }: { reserve: number; top?: number; children: ReactNode }) {
  return (
    <View wrap={false} minPresenceAhead={reserve} style={{ marginTop: top }}>
      {children}
    </View>
  );
}

export function SectionTitle({ title, reserve = FIRST_BLOCK }: { title: string; reserve?: number }) {
  return (
    <Lead reserve={reserve} top={16}>
      <View style={st.rule} />
      <Text style={st.section}>{title}</Text>
    </Lead>
  );
}

export function PartTitle({ title, reserve = FIRST_BLOCK }: { title: string; reserve?: number }) {
  return (
    <Lead reserve={reserve}>
      <Text style={st.part}>{title}</Text>
    </Lead>
  );
}

// Reserva de um título de seção para a parte que o segue: o título da parte (~24 pt) mais o conteúdo.
export const partReserve = (part: SectionPart): number => (part.title ? 24 : 0) + reserveFor(part.value);

// Sem View em volta: o título precisa ser irmão do conteúdo para o `minPresenceAhead` valer.
export function GenericPart({ part }: { part: SectionPart }) {
  return (
    <>
      {part.title ? <PartTitle title={part.title} reserve={reserveFor(part.value)} /> : null}
      <PdfGenericValue value={part.value} />
    </>
  );
}

export function GenericParts({ parts }: { parts: SectionPart[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <GenericPart key={i} part={part} />
      ))}
    </>
  );
}

// Seção sem layout próprio: título e partes pelo motor genérico.
export function GenericSection({ title, parts }: { title: string; parts: SectionPart[] }) {
  const first = parts[0];
  return (
    <>
      <SectionTitle title={title} reserve={first ? partReserve(first) : TEXT_BLOCK} />
      <GenericParts parts={parts} />
    </>
  );
}

export function GenericBlocks({ blocks }: { blocks: GenericBlock[] }) {
  return (
    <>
      {blocks.map((block) => (
        <Fragment key={block.key}>
          <PartTitle title={block.title} reserve={reserveFor(block.value)} />
          {block.note ? <Text style={st.note}>{block.note}</Text> : null}
          <PdfGenericValue value={block.value} />
        </Fragment>
      ))}
    </>
  );
}
