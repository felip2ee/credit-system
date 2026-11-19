import { StyleSheet, Text, View } from "@react-pdf/renderer";

import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "./fonts";
import { confidentialLine, SectionTitle } from "./sections";
import { PdfTable } from "./table";
import { PDF_COLORS, PDF_TYPE } from "./theme";
import type { FullPdfHeader } from "./consultation-full-document";

// A chave dourada ocupa o canto direito: o bloco de identidade fica à esquerda dela.
const IDENTITY_WIDTH = 400;
const COMPANY_ROLE = "Empresa";

export interface CoverMember {
  role: string;
  header: FullPdfHeader;
}

const st = StyleSheet.create({
  eyebrow: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: 9, color: PDF_COLORS.goldText, letterSpacing: 1.2 },
  name: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.name, color: PDF_COLORS.ink, marginTop: 6 },
  line: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.muted, marginTop: 4, lineHeight: 1.3 },
});

// O tipo do dossiê não chega ao renderizador: quem tem empresa entre os membros é empresarial.
export function dossierKindLabel(members: CoverMember[]): string {
  return members.some((member) => member.role === COMPANY_ROLE) ? "Empresarial" : "Pessoa Física";
}

export function DossierCover({
  title,
  subtitle,
  issuedAt,
  members,
}: {
  title: string;
  subtitle: string;
  issuedAt: Date;
  members: CoverMember[];
}) {
  return (
    <>
      <View style={{ width: IDENTITY_WIDTH }}>
        <Text style={st.eyebrow}>{`DOSSIÊ · ${dossierKindLabel(members).toUpperCase()}`}</Text>
        <Text style={st.name}>{title}</Text>
        <Text style={st.line}>{`${subtitle} · Emitido em ${issuedAt.toLocaleDateString("pt-BR")}`}</Text>
        {members[0] ? <Text style={st.line}>{confidentialLine(members[0].header)}</Text> : null}
      </View>
      <SectionTitle title="Consultas do dossiê" />
      {/* A consulta não traz situação própria: a coluna fica vazia e a tabela a descarta. */}
      <PdfTable
        columns={[
          { label: "Papel", type: "short" },
          { label: "Nome", type: "text" },
          { label: "Documento", type: "text" },
          { label: "Situação da consulta", type: "text" },
        ]}
        rows={members.map(({ role, header }) => ({ cells: [role, header.name, header.cpf, ""] }))}
      />
    </>
  );
}
