import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { RetryScrButton } from "@/components/consultations/retry-scr-button";
import {
  CompanyReportPanel,
} from "@/components/batch/company-report-panel";
import { ProcessPendingButton } from "@/components/batch/process-pending-button";
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
import { getBatchDetail } from "@/lib/batch/queries";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

export default async function BatchDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getRequiredSession().catch(() => notFound());
  if (!hasPermission(session.role, "consultations:read")) notFound();
  const detail = await getBatchDetail(session, params.id);
  if (!detail) notFound();
  const { batch: b, members, report } = detail;
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
        title={b.name ?? "Processo de empresa"}
        description={`${b.document ? formatCNPJ(b.document) : "CNPJ não informado"} · ${b.success_items}/${b.total_items} consultas concluídas`}
      >
        {hasCompleted && (
          <Button asChild variant="outline">
            <a href={`/batch/${b.id}/pdf`} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4" />
              Baixar PDF do processo
            </a>
          </Button>
        )}
      </PageHeader>

      {/* Consultas ainda na fila (ex.: aba fechada durante o processamento) */}
      {pendingIds.length > 0 && <ProcessPendingButton queryIds={pendingIds} />}

      {/* Consultas do processo */}
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
                  <TableCell>{m.type === "PJ" ? "Empresa" : "Sócio"}</TableCell>
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
                    Nenhuma consulta neste processo.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Parecer consolidado */}
      <CompanyReportPanel
        batchId={b.id}
        canGenerate={canGenerate}
        report={report}
      />
    </div>
  );
}
