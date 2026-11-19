import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Image, StyleSheet, Text, View } from "@react-pdf/renderer";

import { BRAND_ASSETS } from "@/lib/brand/brand";
import { PDF_FONT_FAMILY, PDF_FONT_FAMILY_BOLD, registerPdfFonts } from "./fonts";
import { PDF_COLORS, PDF_PAGE } from "./theme";

registerPdfFonts();

export interface PdfFrame {
  bureauName: string;
  supportEmail: string;
  issuedAt: Date;
  whatsapp?: string;
  instagram?: string;
  // Linha da 2ª página em diante, ao lado da logo.
  running?: { name: string; document?: string; label: string };
}

// Espaço que o timbrado ocupa na página; o conteúdo fica dentro dele.
export const PDF_PAGE_PADDING_TOP = PDF_PAGE.paddingTop;
export const PDF_PAGE_PADDING_BOTTOM = PDF_PAGE.paddingBottom;

const LOGO_HEIGHT = 52;
const LOGO_TOP = 29;
const LOGO_GAP = 8;
const RUNNING_WIDTH = 330;
const RUNNING_LEFT = PDF_PAGE.paddingX + LOGO_HEIGHT + LOGO_GAP;
// Centraliza as duas linhas (cerca de 29 pt) na altura da logo.
const RUNNING_TOP_OFFSET = 11;
const RUNNING_LINE_GAP = 16;
// A faixa verde de baixo começa em 804 pt e a medalha termina em 110 pt: o texto começa à direita dela.
const FOOTER_LEFT = 134;
const FOOTER_TOP = 819;
const GOLD_LIGHT = "#F0D79A";

const f = StyleSheet.create({
  background: { position: "absolute", left: 0, top: 0, width: PDF_PAGE.width, height: PDF_PAGE.height },
  logo: { position: "absolute", left: PDF_PAGE.paddingX - 4, top: LOGO_TOP, width: LOGO_HEIGHT, height: LOGO_HEIGHT },
  runningName: {
    position: "absolute",
    left: RUNNING_LEFT,
    top: LOGO_TOP + RUNNING_TOP_OFFSET,
    width: RUNNING_WIDTH,
    fontFamily: PDF_FONT_FAMILY_BOLD,
    fontSize: 10.5,
    color: PDF_COLORS.ink,
  },
  runningLabel: {
    position: "absolute",
    left: RUNNING_LEFT,
    top: LOGO_TOP + RUNNING_TOP_OFFSET + RUNNING_LINE_GAP,
    width: RUNNING_WIDTH,
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 9,
    color: PDF_COLORS.muted,
  },
  footer: {
    position: "absolute",
    left: FOOTER_LEFT,
    right: PDF_PAGE.paddingX,
    top: FOOTER_TOP,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerContacts: { fontFamily: PDF_FONT_FAMILY, fontSize: 8.5, color: "#FFFFFF" },
  footerPage: { fontFamily: PDF_FONT_FAMILY_BOLD, fontSize: 8.5, color: GOLD_LIGHT },
});

const dataUriCache = new Map<string, string>();
function imageDataUri(publicPath: string, mime: string): string {
  const cached = dataUriCache.get(publicPath);
  if (cached) return cached;
  const uri = `data:${mime};base64,${readFileSync(join(process.cwd(), "public", publicPath)).toString("base64")}`;
  dataUriCache.set(publicPath, uri);
  return uri;
}

const LETTERHEAD_PATH = "/brand/rainha-cred/timbrado/timbrado-a4.jpg";

export function footerContacts({ supportEmail, whatsapp, instagram }: PdfFrame): string {
  return [supportEmail, whatsapp && `WhatsApp ${whatsapp}`, instagram && `Instagram ${instagram}`].filter(Boolean).join("   ·   ");
}

// Orçamento de caracteres da linha 1 (Helvetica-Bold 10,5 pt cabe em ~330 pt, antes da chave dourada).
// shortcut: estimativa por contagem de caracteres, trocar por medição da fonte se o texto passar a ter outra largura.
const RUNNING_MAX_CHARS = 56;
const IDENTITY_SEPARATOR = "  ·  ";

// Linha 1 nunca quebra: encurta o nome e mantém o documento visível.
export function runningIdentity({ name, document }: { name: string; document?: string }): string {
  const suffix = document ? `${IDENTITY_SEPARATOR}${document}` : "";
  if (name.length + suffix.length <= RUNNING_MAX_CHARS) return name + suffix;
  const room = Math.max(RUNNING_MAX_CHARS - suffix.length - 1, 1);
  return `${name.slice(0, room).trimEnd()}…${suffix}`;
}

// Dois textos `fixed` com `render`: um `View` com `render` e filhos perde a 2ª linha em página que quebra.
// `subPageNumber` conta dentro de cada <Page>: a 1ª página de cada bloco já mostra a identidade, então a linha só aparece da 2ª em diante.
function RunningLine({ running }: { running: NonNullable<PdfFrame["running"]> }) {
  const identity = runningIdentity(running);
  const label = `${running.label} (continuação)`;
  return (
    <>
      <Text fixed style={f.runningName} render={({ subPageNumber }) => (subPageNumber > 1 ? identity : "")} />
      <Text fixed style={f.runningLabel} render={({ subPageNumber }) => (subPageNumber > 1 ? label : "")} />
    </>
  );
}

export function PdfBrandFrame({ frame }: { frame: PdfFrame }) {
  return (
    <>
      {/* eslint-disable jsx-a11y/alt-text */}
      <Image fixed src={imageDataUri(LETTERHEAD_PATH, "image/jpeg")} style={f.background} />
      <Image fixed src={imageDataUri(BRAND_ASSETS.logoPng, "image/png")} style={f.logo} />
      {/* eslint-enable jsx-a11y/alt-text */}
      {frame.running ? <RunningLine running={frame.running} /> : null}
      <View fixed style={f.footer}>
        <Text style={f.footerContacts}>{footerContacts(frame)}</Text>
        <Text style={f.footerPage} render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
      </View>
    </>
  );
}
