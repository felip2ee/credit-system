import { StyleSheet, Text, View } from "@react-pdf/renderer";

import type { FullConsultationView } from "@/types/consultation-view";

import type { PdfDocumentKind } from "../complete-consultation-document";
import type { FullPdfHeader } from "../consultation-full-document";
import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD } from "../fonts";
import { PDF_COLORS, PDF_TYPE } from "../theme";
import { fieldText, findPart, isBlankText } from "./cells";

// A chave dourada ocupa o canto direito: o bloco de identidade fica à esquerda dela.
export const IDENTITY_WIDTH = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const identityStyles = StyleSheet.create({
  eyebrow: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: 9, color: PDF_COLORS.goldText, letterSpacing: 1.2 },
  // lineHeight e marginBottom explícitos: sem eles, as descendentes de um nome em duas linhas encostam na linha de baixo.
  name: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: PDF_TYPE.name, color: PDF_COLORS.ink, marginTop: 6, marginBottom: 6, lineHeight: 1.2 },
  line: { fontFamily: PDF_FONT_FAMILY, fontSize: PDF_TYPE.body, color: PDF_COLORS.muted, marginTop: 4, lineHeight: 1.3 },
});

// Espaço não separável (U+00A0), escrito por escape para não virar espaço comum ao editar o arquivo.
const NBSP = "\u00A0";

// Cada dado é uma peça que não quebra por dentro e o separador fica colado à peça seguinte:
// a linha só quebra entre peças e nunca termina em "·".
export function joinParts(parts: string[]): string {
  return parts.map((part) => part.replace(/ /g, NBSP)).join(` ·${NBSP}`);
}

// ID interno do usuário (UUID, só dígitos ou e-mail) não aparece no PDF; nome aparece.
const isInternalUserId = (user: string): boolean => UUID.test(user) || /^\d+$/.test(user) || user.includes("@");

export function confidentialLine(header: Pick<FullPdfHeader, "consultante" | "usuario">): string {
  const user = header.usuario && !isInternalUserId(header.usuario) ? ` · Usuário ${header.usuario}` : "";
  return `Confidencial para ${header.consultante}${user}`;
}

export function eyebrowText(kind: PdfDocumentKind, produto: string, roleLabel?: string): string {
  const prefix = kind === "dossie" ? "DOSSIÊ" : "RELATÓRIO DE CONSULTA";
  return [prefix, roleLabel, produto].filter(Boolean).join(" · ");
}

// Dados de cadastro que já estão nas seções; só entram na identidade os que existem.
function registryParts(header: FullPdfHeader, full: FullConsultationView | null): string[] {
  const person = full?.sections.find((section) => section.id === "pessoa");
  const income = full?.sections.find((section) => section.id === "rendaPresumida");
  const birth = fieldText(person && findPart(person, null), "dataNascimento");
  const age = fieldText(person && findPart(person, null), "idade");
  const status = fieldText(person && findPart(person, null), "situacaoCadastral");
  const value = fieldText(income && findPart(income, null), "valor");
  return [
    `${header.docLabel ?? "CPF"} ${header.cpf}`,
    isBlankText(birth) ? "" : `Nascimento ${birth}${isBlankText(age) ? "" : ` (${age} anos)`}`,
    isBlankText(status) ? "" : `Situação cadastral ${status}`,
    isBlankText(value) ? "" : `Renda presumida ${value}`,
    `Consulta de ${header.data}`,
  ].filter(Boolean);
}

export function Identity({
  header,
  full,
  eyebrow,
}: {
  header: FullPdfHeader;
  full: FullConsultationView | null;
  eyebrow: string;
}) {
  return (
    <View style={{ width: IDENTITY_WIDTH }}>
      <Text style={identityStyles.eyebrow}>{eyebrow}</Text>
      <Text style={identityStyles.name}>{header.name}</Text>
      <Text style={identityStyles.line}>{joinParts(registryParts(header, full))}</Text>
      <Text style={identityStyles.line}>{confidentialLine(header)}</Text>
      {header.endereco ? <Text style={identityStyles.line}>{header.endereco}</Text> : null}
    </View>
  );
}
