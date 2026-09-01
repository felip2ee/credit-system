import Link from "next/link";
import { Download, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { ConsultationsFilters } from "@/components/consultations/consultations-filters";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { ReprocessButton } from "@/components/consultations/reprocess-button";
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
import { listConsultations } from "@/lib/consultations/queries";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";

interface SearchParams {
  q?: string;
  type?: string;
  status?: string;
  from?: string;
  to?: string;
}

export default async function ConsultationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getRequiredSession();
  if (!hasPermission(session.role, "consultations:read")) return null;
  const queries = await listConsultations({ userId: session.userId, role: session.role }, {
    q: searchParams.q,
    type: searchParams.type === "PF" || searchParams.type === "PJ" ? searchParams.type : undefined,
    status: searchParams.status && searchParams.status in QUERY_STATUS_LABEL ? searchParams.status as QueryStatus : undefined,
    from: searchParams.from, to: searchParams.to,
  });

  const exportQs = new URLSearchParams(
    Object.entries(searchParams).filter(([, v]) => v) as [string, string][]
  ).toString();

  return (
    <div className="space-y-6">
      <PageHeader title="Consultas" description="Histórico de consultas ao bureau">
        <Button asChild variant="outline">
          <a href={`/consultations/export${exportQs ? `?${exportQs}` : ""}`}>
            <Download className="h-4 w-4" />
            Exportar CSV
          </a>
        </Button>
        <Button asChild>
          <Link href="/consultations/new">
            <Plus className="h-4 w-4" />
            Nova consulta
          </Link>
        </Button>
      </PageHeader>

      <ConsultationsFilters />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queries.map((q) => (
                <TableRow key={q.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/consultations/${q.id}`}
                      className="hover:underline"
                    >
                      {q.document_name ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell>{q.type}</TableCell>
                  <TableCell>
                    {q.type === "PJ"
                      ? formatCNPJ(q.document)
                      : formatCPF(q.document)}
                  </TableCell>
                  <TableCell>{q.product ?? "—"}</TableCell>
                  <TableCell>
                    <QueryStatusBadge status={q.status} />
                  </TableCell>
                  <TableCell>{formatDate(q.created_at)}</TableCell>
                  <TableCell className="text-right">
                    {q.status === "error" && <ReprocessButton queryId={q.id} />}
                  </TableCell>
                </TableRow>
              ))}
              {queries.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
                    Nenhuma consulta encontrada.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
