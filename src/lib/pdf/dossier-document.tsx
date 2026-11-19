import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";

import { BRAND_NAME } from "@/lib/brand/brand";
import { PdfBrandFrame, type PdfFrame } from "./brand-frame";
import { pdfStyles as s, type FullPdfHeader } from "./consultation-full-document";
import { ConsultationPdfPage } from "./complete-consultation-document";
import type { ConsultationContent } from "@/lib/consultations/full-view";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";
import { DossierCover } from "./dossier-cover";
import { SectionTitle } from "./sections";
import { PDF_COLORS } from "./theme";

// PDF único do Dossiê: capa com a lista de membros, uma <Page> por consulta (empresa
// primeiro, depois cada sócio) e, ao final, o parecer consolidado do quadro societário.
// Cada <Page> começa em página nova e repete o timbrado; a numeração "Página X de Y" corre o documento todo.

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

// Papel do membro: "Empresa", "Titular" ou "Sócio". Vai em roleLabel; o produto segue sem o papel.
function DossierDocument({
  data,
  frame,
}: {
  data: DossierPdfData;
  frame: PdfFrame;
}) {
  const last = data.entries.length - 1;
  const opinionFrame: PdfFrame = {
    ...frame,
    // Nome curto: a linha corrente da marca cabe em duas linhas no máximo.
    running: { name: "Parecer consolidado", label: "Dossiê" },
  };
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfBrandFrame frame={frame} />
        <DossierCover
          title={data.title}
          subtitle={data.subtitle}
          issuedAt={frame.issuedAt}
          members={data.entries.map(({ role, header }) => ({ role, header }))}
        />
      </Page>

      {data.entries.map((e, i) => (
        <ConsultationPdfPage
          key={i}
          {...e.content}
          header={e.header}
          frame={frame}
          roleLabel={e.role}
          documentKind="dossie"
          closingNote={!data.report && i === last}
        />
      ))}

      {data.report && (
        <Page size="A4" style={s.page}>
          <PdfBrandFrame frame={opinionFrame} />
          <SectionTitle title="Parecer consolidado" />
          <Text style={{ color: PDF_COLORS.muted, marginBottom: 6 }}>{data.title}</Text>
          <Text style={{ color: PDF_COLORS.muted, marginBottom: 6 }}>{data.subtitle}</Text>
          <SectionTitle title="Parecer do quadro societário" reserve={120} />
          <OpinionBlock opinion={data.report} />
          <Text style={{ fontSize: 9, color: PDF_COLORS.muted, marginTop: 20, textAlign: "right" }}>
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
