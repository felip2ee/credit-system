import { Document, Page, View, Text, renderToBuffer } from "@react-pdf/renderer";

import { FULL_DATA_UNAVAILABLE, type ConsultationContent } from "@/lib/consultations/full-view";
import type { FullConsultationView } from "@/types/consultation-view";

import {
  Bg,
  FullConsultationPage,
  ScoreBar,
  Section,
  pdfStyles as s,
  type FullPdfHeader,
} from "./consultation-full-document";
import { PdfGenericValue } from "./generic-block";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";

const MUTED = "#6b7280";

export interface CompleteConsultationPageProps {
  full: FullConsultationView;
  header: FullPdfHeader;
  letterhead: string;
  opinion?: OpinionForPdf | null;
}

export function CompleteConsultationPage({ full, header, letterhead, opinion }: CompleteConsultationPageProps) {
  return (
    <Page size="A4" style={s.page}>
      <Bg letterhead={letterhead} />

      <View style={s.header}>
        <Text style={s.title}>{header.name}</Text>
        <Text style={s.sub}>{header.docLabel ?? "CPF"} {header.cpf} · {header.data}</Text>
        <Text style={s.sub}>Confidencial para {header.consultante} · Usuário {header.usuario}</Text>
        {header.endereco ? <Text style={s.sub}>{header.endereco}</Text> : null}
      </View>

      {full.sections.map((section) => (
        <Section key={section.id} title={section.title}>
          {section.id === "score" && full.scoreValue != null && <ScoreBar valor={full.scoreValue} />}
          {section.parts.map((part, i) => (
            <View key={i}>
              {part.title ? <Text style={s.sh}>{part.title}</Text> : null}
              <PdfGenericValue value={part.value} />
            </View>
          ))}
        </Section>
      ))}

      {full.generic.length > 0 && (
        <Section title="Outros dados">
          {full.generic.map((block) => (
            <View key={block.key}>
              <Text style={s.sh}>{block.title}</Text>
              {block.note ? <Text style={[s.li, { color: MUTED }]}>{block.note}</Text> : null}
              <PdfGenericValue value={block.value} />
            </View>
          ))}
        </Section>
      )}

      {opinion && (
        <Section title="Parecer de IA">
          <OpinionBlock opinion={opinion} />
        </Section>
      )}

      <Text style={{ fontSize: 7, color: MUTED, marginTop: 20, textAlign: "right" }}>
        Documento gerado automaticamente · Reino do Crédito
      </Text>
    </Page>
  );
}

export type ConsultationPdfPageProps = ConsultationContent & {
  header: FullPdfHeader;
  letterhead: string;
  opinion?: OpinionForPdf | null;
};

export function ConsultationPdfPage({ full, view, header, letterhead, opinion }: ConsultationPdfPageProps) {
  if (full) return <CompleteConsultationPage full={full} header={header} letterhead={letterhead} opinion={opinion} />;
  if (!view) return null;
  // shortcut: reaproveita a linha de endereço para a nota; dê linha própria se consultation-full-document for dividido.
  const endereco = [header.endereco, FULL_DATA_UNAVAILABLE].filter(Boolean).join(" · ");
  return <FullConsultationPage view={view} header={{ ...header, endereco }} letterhead={letterhead} opinion={opinion} />;
}

export function renderCompleteConsultationPdf(
  content: ConsultationContent,
  header: FullPdfHeader,
  letterhead: string,
  opinion?: OpinionForPdf | null,
): Promise<Buffer> {
  return renderToBuffer(
    <Document>
      <ConsultationPdfPage {...content} header={header} letterhead={letterhead} opinion={opinion} />
    </Document>,
  );
}
