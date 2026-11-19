import { Text, View } from "@react-pdf/renderer";

import { confidentialLine, IDENTITY_WIDTH, identityStyles, SectionTitle } from "./sections";
import { PdfTable } from "./table";
import type { FullPdfHeader } from "./consultation-full-document";

const BUSINESS_ROLES = ["Empresa", "Sócio"];

export interface CoverMember {
  role: string;
  header: FullPdfHeader;
}

// O tipo do dossiê não chega ao renderizador. A consulta da empresa pode faltar (a rota descarta a que não
// completou) e restar só os sócios: papel "Empresa" ou "Sócio" é empresarial; só "Titular" é pessoa física.
export function dossierKindLabel(members: CoverMember[]): string {
  return members.some((member) => BUSINESS_ROLES.includes(member.role)) ? "Empresarial" : "Pessoa Física";
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
        <Text style={identityStyles.eyebrow}>{`DOSSIÊ · ${dossierKindLabel(members).toUpperCase()}`}</Text>
        <Text style={identityStyles.name}>{title}</Text>
        <Text style={identityStyles.line}>{`${subtitle} · Emitido em ${issuedAt.toLocaleDateString("pt-BR")}`}</Text>
        {members[0] ? <Text style={identityStyles.line}>{confidentialLine(members[0].header)}</Text> : null}
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
