import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Image, StyleSheet, Text, View } from "@react-pdf/renderer";

import { BRAND_ASSETS } from "@/lib/brand/brand";
import { BRAND_COLORS } from "@/lib/brand/tokens";
import { registerPdfFonts } from "./fonts";

// Toda página usa a fonte Atkinson; quem importa o quadro já a tem registrada.
registerPdfFonts();

export interface PdfFrame {
  bureauName: string;
  supportEmail: string;
  issuedAt: Date;
}

// Espaço que o cabeçalho e o rodapé fixos ocupam na página.
export const PDF_PAGE_PADDING_TOP = 100;
export const PDF_PAGE_PADDING_BOTTOM = 64;

const LOGO_SIZE = 48;
const PAD_X = 42;

const f = StyleSheet.create({
  header: {
    position: "absolute",
    top: 24,
    left: PAD_X,
    right: PAD_X,
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: BRAND_COLORS.brand,
  },
  logo: { width: LOGO_SIZE, height: LOGO_SIZE },
  name: { flex: 1, marginHorizontal: 12, fontSize: 11, fontWeight: 700, lineHeight: 1.3, color: BRAND_COLORS.ink },
  issued: { fontSize: 9, color: BRAND_COLORS.ink },
  footer: {
    position: "absolute",
    bottom: 24,
    left: PAD_X,
    right: PAD_X,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: BRAND_COLORS.brand,
    fontSize: 9,
    color: BRAND_COLORS.ink,
  },
});

let logoCache: string | null = null;
function logoDataUri(): string {
  if (logoCache) return logoCache;
  const png = readFileSync(join(process.cwd(), "public", BRAND_ASSETS.logoPng));
  logoCache = `data:image/png;base64,${png.toString("base64")}`;
  return logoCache;
}

const issuedLabel = (d: Date) => `Emitido em ${d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;

export function PdfBrandHeader({ bureauName, issuedAt }: { bureauName: string; issuedAt: Date }) {
  return (
    <View style={f.header} fixed>
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <Image src={logoDataUri()} style={f.logo} />
      <Text style={f.name}>{bureauName}</Text>
      <Text style={f.issued}>{issuedLabel(issuedAt)}</Text>
    </View>
  );
}

export function PdfBrandFooter({ supportEmail }: { supportEmail: string }) {
  return (
    <View style={f.footer} fixed>
      <Text>{supportEmail}</Text>
      <Text render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
    </View>
  );
}

export function PdfBrandFrame({ frame }: { frame: PdfFrame }) {
  return (
    <>
      <PdfBrandHeader bureauName={frame.bureauName} issuedAt={frame.issuedAt} />
      <PdfBrandFooter supportEmail={frame.supportEmail} />
    </>
  );
}
