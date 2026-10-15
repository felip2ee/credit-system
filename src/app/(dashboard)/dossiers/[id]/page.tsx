import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { DossierStatusBadge, DOSSIER_KIND_LABEL } from "@/components/dossiers/dossier-badges";
import { RetryScrButton } from "@/components/consultations/retry-scr-button";
import { DossierReportPanel } from "@/components/dossiers/dossier-report-panel";
import { ProcessPendingButton } from "@/components/dossiers/process-pending-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { getDossierDetail } from "@/lib/dossiers/queries";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export default async function DossierDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "consultations:read") || !isUuid(params.id)) notFound();
  const detail = await getDossierDetail(session, params.id);
  if (!detail) notFound();
  const { dossier: d, members, report } = detail;
  const canWrite = hasPermission(session, "consultations:write");
  const completedCount = members.filter((m) => m.status === "completed").length;
  // Empresa (PJ) primeiro, depois sócios (PF).
  const ordered = [...members].sort((a, b2) =>
    a.type === b2.type ? 0 : a.type === "PJ" ? -1 : 1
  );

  const canGenerate = members.some((m) => m.type === "PJ" && m.status === "completed");
  const hasCompleted = members.some((m) => m.status === "completed");
  const pendingIds = members
    .filter((m) => m.status === "processing")
    .map((m) => m.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.holder_name}
        description={`${DOSSIER_KIND_LABEL[d.kind]} · ${completedCount}/${members.length} consultas concluídas`}
      >
        <DossierStatusBadge status={d.status} />
        <Button asChild variant="outline">
          <Link href={`/holders/${d.holder_id}`}>Ver titular</Link>
        </Button>
        {hasPermission(session, "counter:read") && (
          <Button asChild variant="outline">
            <Link href={`/settings/counter-payments?dossier=${d.id}`}>Pagamentos de balcão</Link>
          </Button>
        )}
        {hasCompleted && (
          <Button asChild variant="outline">
            <a href={`/dossiers/${d.id}/pdf`} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4" />
              Baixar PDF da pesquisa
            </a>
          </Button>
        )}
      </PageHeader>

      {/* Consultas ainda na fila (ex.: aba fechada durante o processamento) */}
      {canWrite && pendingIds.length > 0 && <ProcessPendingButton queryIds={pendingIds} />}

      {/* Consultas da pesquisa */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Papel</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Consultado em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">
                    <Link href={`/consultations/${m.id}`} className="hover:underline">
                      {m.document_name ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell>{m.type === "PJ" ? "Empresa" : d.kind === "PF" ? "Titular" : "Sócio"}</TableCell>
                  <TableCell className="font-mono">
                    {m.type === "PJ" ? formatCNPJ(m.document) : formatCPF(m.document)}
                  </TableCell>
                  <TableCell>
                    <QueryStatusBadge status={m.status} />
                  </TableCell>
                  <TableCell>{formatDate(m.consulted_at)}</TableCell>
                  <TableCell className="text-right">
                    {m.status === "pending_authorization" && (
                      <RetryScrButton queryId={m.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {ordered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Nenhuma consulta nesta pesquisa.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Parecer consolidado: só o PJ completo reúne empresa e sócios */}
      {d.kind === "PJ_FULL" && (
        <DossierReportPanel
          dossierId={d.id}
          canGenerate={canGenerate && hasPermission(session, "reports:write")}
          report={report}
        />
      )}
    </div>
  );
}
