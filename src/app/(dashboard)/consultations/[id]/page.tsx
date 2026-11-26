import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import {
  ConsultationResult,
  ConsultationUnavailable,
} from "@/components/consultations/consultation-result";
import { FullConsultationResult } from "@/components/consultations/full-consultation-result";
import {
  ConsultationOpinion,
  type OpinionData,
} from "@/components/consultations/consultation-opinion";
import type { Parecer } from "@/types/ai";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { getConsultation, getConsultationReport } from "@/lib/consultations/queries";
import { FULL_DATA_UNAVAILABLE, toConsultationContent, type ConsultationContent } from "@/lib/consultations/full-view";
import { incompatibleView } from "@/lib/consultations/view-model";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

export default async function ConsultationDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getRequiredSession();
  if (!hasPermission(session, "consultations:read")) notFound();
  const query = await getConsultation(session, params.id);
  if (!query) notFound();

  const docLabel =
    query.type === "PJ" ? formatCNPJ(query.document) : formatCPF(query.document);

  // `payload_incompatible` não faz parte do enum tipado de `queries` (Tasks 9/11).
  let content: ConsultationContent | null = null;
  let opinion: OpinionData | null = null;
  if (query.status === "completed" || query.status === "payload_incompatible") {
    // payload_incompatible, ou consulta histórica sem payload nem canônico, cai em incompatibleView.
    const [payload, canonical] = await Promise.all([
      loadLatestPayload(session, query.id),
      loadCanonicalResult(session, query.id),
    ]);
    content = toConsultationContent(payload, canonical);

    const reportRow = await getConsultationReport(session, query.id);
    if (reportRow) {
      const r = reportRow as Record<string, unknown>;
      opinion = {
        status: (r.status as string) ?? "generating",
        aptitude_status: (r.aptitude_status as string) ?? "pending",
        generation_error: (r.generation_error as string | null) ?? null,
        report_markdown: (r.report_markdown as string | null) ?? null,
        full_report: (r.full_report as Parecer | null) ?? null,
        model_used: (r.model_used as string | null) ?? null,
        generated_at: (r.generated_at as string | null) ?? null,
      };
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={query.document_name ?? docLabel}
        description={`${query.product ?? "Consulta"} · ${docLabel} · ${formatDate(query.consulted_at ?? query.created_at)}`}
      >
        <QueryStatusBadge status={query.status} />
        {query.status === "completed" && (
          <Button asChild variant="outline">
            <a href={`/consultations/${query.id}/pdf`} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4" />
              Baixar PDF
            </a>
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={`/dossiers/${query.dossier_id}`}>Ver pesquisa</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/holders/${query.holder_id}`}>Ver titular</Link>
        </Button>
      </PageHeader>

      {query.status === "pending_authorization" && (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">
              Consulta aguardando a autorização SCR do titular. Assim que ele autorizar, o pedido segue sozinho.
              Acompanhe o estado em{" "}
              <Link href={`/dossiers/${query.dossier_id}`} className="underline">
                Ver pesquisa
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}

      {query.status === "error" && (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-destructive">
              {query.error_message ?? "Erro ao processar a consulta."}
            </p>
          </CardContent>
        </Card>
      )}

      {query.status === "completed" && (
        <ConsultationOpinion queryId={query.id} report={opinion} />
      )}

      {content &&
        (content.full ? (
          <FullConsultationResult view={content.full} />
        ) : content.view ? (
          <>
            <p className="text-sm text-muted-foreground">{FULL_DATA_UNAVAILABLE}</p>
            <ConsultationResult view={content.view} />
          </>
        ) : (
          <ConsultationUnavailable {...incompatibleView(query.id)} />
        ))}
    </div>
  );
}
