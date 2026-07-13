import { Document, Page, View, Text, renderToBuffer } from "@react-pdf/renderer";

import {
  Bg,
  FullConsultationPage,
  pdfStyles as s,
  type FullPdfHeader,
  type PfMix,
} from "./consultation-full-document";
import { OpinionBlock, type OpinionForPdf } from "./markdown-pdf";

// PDF único do processamento de empresa: uma página por consulta (empresa
// primeiro, depois cada sócio) e, ao final, o parecer consolidado do quadro
// societário. Cada consulta é uma <Page>, então a quebra entre elas é garantida
// e todas repetem o timbrado — pronto para impressão.

export interface CompanyProcessEntry {
  mix: PfMix;
  header: FullPdfHeader;
  // "Empresa" ou "Sócio" — exibido na abertura da página.
  role: string;
}

export interface CompanyProcessPdfData {
  title: string;
  subtitle: string;
  entries: CompanyProcessEntry[];
  report: OpinionForPdf | null;
}

const muted = "#6b7280";

function CompanyProcessDocument({
  data,
  letterhead,
}: {
  data: CompanyProcessPdfData;
  letterhead: string;
}) {
  return (
    <Document>
      {data.entries.map((e, i) => (
        <FullConsultationPage
          key={i}
          mix={e.mix}
          header={{ ...e.header, produto: `${e.role} · ${e.header.produto}` }}
          letterhead={letterhead}
        />
      ))}

      {data.report && (
        <Page size="A4" style={s.page}>
          <Bg letterhead={letterhead} />
          <View style={s.header}>
            <Text style={s.title}>Parecer consolidado</Text>
            <Text style={s.sub}>{data.title}</Text>
            <Text style={s.sub}>{data.subtitle}</Text>
          </View>
          <View style={s.section}>
            <Text style={s.h}>Parecer do quadro societário</Text>
            <OpinionBlock opinion={data.report} />
          </View>
          <Text style={{ fontSize: 7, color: muted, marginTop: 20, textAlign: "right" }}>
            Documento gerado automaticamente · Reino do Crédito
          </Text>
        </Page>
      )}
    </Document>
  );
}

export function renderCompanyProcessPdf(
  data: CompanyProcessPdfData,
  letterhead: string
): Promise<Buffer> {
  return renderToBuffer(<CompanyProcessDocument data={data} letterhead={letterhead} />);
}
