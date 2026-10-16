import { MarkdownReport } from "@/components/shared/markdown-report";
import type { LegalDocument } from "@/lib/account/queries";
import { formatDate } from "@/lib/utils";

export interface LegalDocumentViewProps {
  document: LegalDocument;
}

export function LegalDocumentView({ document }: LegalDocumentViewProps) {
  return (
    <article className="space-y-2">
      <h1 className="text-2xl font-semibold">{document.title}</h1>
      <p className="text-sm text-muted-foreground">
        Versão {document.version} · publicada em {formatDate(document.publishedAt)}
      </p>
      <div className="text-sm">
        <MarkdownReport>{document.bodyMd}</MarkdownReport>
      </div>
    </article>
  );
}
