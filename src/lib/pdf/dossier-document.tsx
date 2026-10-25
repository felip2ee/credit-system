import { Document, Page, View, Text, renderToBuffer } from "@react-pdf/renderer";

import { BRAND_NAME } from "@/lib/brand/brand";
import { PdfBrandFrame, type PdfFrame } from "./brand-frame";
import { pdfStyles as s, type FullPdfHeader } from "./consultation-full-document";
import { ConsultationPdfPage } from "./complete-consultation-document";
import type { ConsultationContent } from "@/lib/consultations/full-view";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";

// PDF único do Dossiê: uma página por consulta (empresa
// primeiro, depois cada sócio) e, ao final, o parecer consolidado do quadro
// societário. Cada consulta é uma <Page>, então a quebra entre elas é garantida
// e todas repetem cabeçalho e rodapé da marca — pronto para impressão.

export interface DossierEntry {
  content: ConsultationContent;
  header: FullPdfHeader;
  // "Empresa", "Titular" ou "Sócio" — exibido na abertura da página.
  role: string;
}

export interface DossierPdfData {
  title: string;
  subtitle: string;
  entries: DossierEntry[];
  report: OpinionForPdf | null;
}

const muted = "#6b7280";

function DossierDocument({
  data,
  frame,
}: {
  data: DossierPdfData;
  frame: PdfFrame;
}) {
  return (
    <Document>
      {data.entries.map((e, i) => (
        <ConsultationPdfPage
          key={i}
          {...e.content}
          header={{ ...e.header, produto: `${e.role} · ${e.header.produto}` }}
          frame={frame}
        />
      ))}

      {data.report && (
        <Page size="A4" style={s.page}>
          <PdfBrandFrame frame={frame} />
          <View style={s.header}>
            <Text style={s.title}>Parecer consolidado</Text>
            <Text style={s.sub}>{data.title}</Text>
            <Text style={s.sub}>{data.subtitle}</Text>
          </View>
          <View style={s.section}>
            <Text style={s.h}>Parecer do quadro societário</Text>
            <OpinionBlock opinion={data.report} />
          </View>
          <Text style={{ fontSize: 9, color: muted, marginTop: 20, textAlign: "right" }}>
            Documento gerado automaticamente · {BRAND_NAME}
          </Text>
        </Page>
      )}
    </Document>
  );
}

export function renderDossierPdf(
  data: DossierPdfData,
  frame: PdfFrame
): Promise<Buffer> {
  return renderToBuffer(<DossierDocument data={data} frame={frame} />);
}
