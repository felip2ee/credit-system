import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import {
  ConsultationResult,
  ConsultationUnavailable,
} from "@/components/consultations/consultation-result";
import { ReprocessButton } from "@/components/consultations/reprocess-button";
import { RetryScrButton } from "@/components/consultations/retry-scr-button";
import {
  ConsultationOpinion,
  type OpinionData,
} from "@/components/consultations/consultation-opinion";
import type { Parecer } from "@/types/ai";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult } from "@/lib/consultations/canonical-store";
import { getConsultation, getConsultationReport } from "@/lib/consultations/queries";
import {
  toConsultationView,
  incompatibleView,
  type ConsultationView,
  type IncompatibleView,
} from "@/lib/consultations/view-model";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

export default async function ConsultationDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getRequiredSession();
  if (!hasPermission(session.role, "consultations:read")) notFound();
  const identity = { userId: session.userId, role: session.role } as const;
  const query = await getConsultation(identity, params.id);
  if (!query) notFound();

  const docLabel =
    query.type === "PJ" ? formatCNPJ(query.document) : formatCPF(query.document);

  // `payload_incompatible` não faz parte do enum tipado de `queries` (Tasks 9/11).
  let view: ConsultationView | IncompatibleView | null = null;
  let opinion: OpinionData | null = null;
  if (query.status === "completed" || query.status === "payload_incompatible") {
    const canonical = await loadCanonicalResult(identity, query.id);
    if (canonical) {
      view = toConsultationView(canonical);
    } else {
      // payload_incompatible, ou consulta histórica ainda não migrada (Task 14).
      view = incompatibleView(query.id);
    }

    const reportRow = await getConsultationReport(identity, query.id);
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
        {query.crm_client_id && (
          <Button asChild variant="outline">
            <Link href={`/clients/${query.crm_client_id}`}>Ver cliente</Link>
          </Button>
        )}
      </PageHeader>

      {query.status === "pending_authorization" && (
        <Card>
          <CardContent className="space-y-4 p-6">
            <p className="text-sm text-muted-foreground">
              Consulta aguardando autorização SCR do consultado. Conceda a
              autorização no <span className="font-medium">portal da deps</span> e use{" "}
              <span className="font-medium">Tentar novamente</span> para reverificar:
              assim que o titular estiver autorizado, a consulta é concluída na hora.
              Você também pode acompanhar em{" "}
              <Link href="/scr" className="underline">
                Autorizações SCR
              </Link>
              .
            </p>
            <RetryScrButton queryId={query.id} />
          </CardContent>
        </Card>
      )}

      {query.status === "error" && (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm text-destructive">
              {query.error_message ?? "Erro ao processar a consulta."}
            </p>
            <ReprocessButton queryId={query.id} />
          </CardContent>
        </Card>
      )}

      {view &&
        (view.incompatible ? (
          <ConsultationUnavailable
            consultationId={view.consultationId}
            message={view.message}
          />
        ) : (
          <ConsultationResult view={view} />
        ))}

      {query.status === "completed" && (
        <ConsultationOpinion queryId={query.id} report={opinion} />
      )}
    </div>
  );
}
