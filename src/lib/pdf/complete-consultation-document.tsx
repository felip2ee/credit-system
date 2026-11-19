import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { Fragment } from "react";

import { BRAND_NAME } from "@/lib/brand/brand";
import { FULL_DATA_UNAVAILABLE, type ConsultationContent } from "@/lib/consultations/full-view";
import type { FullConsultationView } from "@/types/consultation-view";

import { PdfBrandFrame, type PdfFrame } from "./brand-frame";
import { FullConsultationPage, pdfStyles as s, type FullPdfHeader } from "./consultation-full-document";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";
import {
  GenericBlocks,
  GenericSection,
  Identity,
  SectionTitle,
  Summary,
  eyebrowText,
  renderCuratedSection,
} from "./sections";
import { PDF_COLORS } from "./theme";

export type PdfDocumentKind = "consulta" | "dossie";

interface PageOptions {
  // Papel do membro num dossiê ("Empresa", "Titular", "Sócio"); entra na linha superior da identidade.
  roleLabel?: string;
  documentKind?: PdfDocumentKind;
  // "Documento gerado automaticamente"; o dossiê imprime uma vez, no fim.
  closingNote?: boolean;
}

export interface CompleteConsultationPageProps extends PageOptions {
  full: FullConsultationView;
  header: FullPdfHeader;
  frame: PdfFrame;
  opinion?: OpinionForPdf | null;
}

function ClosingNote() {
  return (
    <Text style={{ fontSize: 9, color: PDF_COLORS.muted, marginTop: 20, textAlign: "right" }}>
      Documento gerado automaticamente · {BRAND_NAME}
    </Text>
  );
}

export function CompleteConsultationPage({
  full,
  header,
  frame,
  opinion,
  roleLabel,
  documentKind = "consulta",
  closingNote = true,
}: CompleteConsultationPageProps) {
  return (
    <Page size="A4" style={s.page}>
      <PdfBrandFrame frame={frame} />
      <Identity header={header} full={full} eyebrow={eyebrowText(documentKind, header.produto, roleLabel)} />
      <Summary full={full} />

      {full.sections.map((section) => (
        <Fragment key={section.id}>
          {renderCuratedSection(section, { scoreValue: full.scoreValue }) ?? (
            <GenericSection title={section.title} parts={section.parts} />
          )}
        </Fragment>
      ))}

      {full.generic.length > 0 && (
        <>
          <SectionTitle title="Outros dados" />
          <GenericBlocks blocks={full.generic} />
        </>
      )}

      {opinion && (
        <>
          <SectionTitle title="Parecer de IA" reserve={120} />
          <OpinionBlock opinion={opinion} />
        </>
      )}

      {closingNote ? <ClosingNote /> : null}
    </Page>
  );
}

export type ConsultationPdfPageProps = ConsultationContent &
  PageOptions & {
    header: FullPdfHeader;
    frame: PdfFrame;
    opinion?: OpinionForPdf | null;
  };

// Linha da 2ª página em diante: quem é o titular (ou papel e membro, no dossiê) e que documento é.
function withRunningLine(frame: PdfFrame, header: FullPdfHeader, roleLabel: string | undefined, kind: PdfDocumentKind): PdfFrame {
  if (frame.running) return frame;
  return {
    ...frame,
    running: {
      name: roleLabel ? `${roleLabel} · ${header.name}` : header.name,
      document: `${header.docLabel ?? "CPF"} ${header.cpf}`,
      label: kind === "dossie" ? "Dossiê" : "Relatório de consulta",
    },
  };
}

export function ConsultationPdfPage({ full, view, header, frame, opinion, roleLabel, documentKind = "consulta", closingNote = true }: ConsultationPdfPageProps) {
  const framed = withRunningLine(frame, header, roleLabel, documentKind);
  if (full) {
    return (
      <CompleteConsultationPage
        full={full}
        header={header}
        frame={framed}
        opinion={opinion}
        roleLabel={roleLabel}
        documentKind={documentKind}
        closingNote={closingNote}
      />
    );
  }
  if (!view) return null;
  // shortcut: reaproveita a linha de endereço para a nota; dê linha própria se consultation-full-document for dividido.
  const endereco = [header.endereco, FULL_DATA_UNAVAILABLE].filter(Boolean).join(" · ");
  return <FullConsultationPage view={view} header={{ ...header, endereco }} frame={framed} opinion={opinion} closingNote={closingNote} />;
}

export function renderCompleteConsultationPdf(
  content: ConsultationContent,
  header: FullPdfHeader,
  frame: PdfFrame,
  opinion?: OpinionForPdf | null,
): Promise<Buffer> {
  return renderToBuffer(
    <Document>
      <ConsultationPdfPage {...content} header={header} frame={frame} opinion={opinion} />
    </Document>,
  );
}
