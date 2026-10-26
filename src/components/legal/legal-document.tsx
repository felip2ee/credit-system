import { MarkdownReport } from "@/components/shared/markdown-report";
import type { LegalDocument } from "@/lib/account/queries";
import { formatDate } from "@/lib/utils";

export interface LegalDocumentViewProps {
  document: LegalDocument;
}

export function LegalDocumentView({ document }: LegalDocumentViewProps) {
  return (
    <article className="space-y-3 rounded-card bg-background p-5 sm:p-8">
      <h1 className="text-3xl font-bold">{document.title}</h1>
      <p className="text-base text-muted-foreground">
        Versão {document.version} · publicada em {formatDate(document.publishedAt)}
      </p>
      <div>
        <MarkdownReport>{document.bodyMd}</MarkdownReport>
      </div>
    </article>
  );
}
