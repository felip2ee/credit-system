import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";

import { DetailHeader } from "@/components/dashboard/detail-header";
import { StackedList, StackedRow } from "@/components/dashboard/stacked-list";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { DossierStatusBadge, DOSSIER_KIND_LABEL } from "@/components/dossiers/dossier-badges";
import { DossierReportPanel } from "@/components/dossiers/dossier-report-panel";
import { OrderPanel } from "@/components/dossiers/order-panel";
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
import { maskRecipient } from "@/lib/auth/email";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getDossierDetail } from "@/lib/dossiers/queries";
import { getStaffOrder } from "@/lib/orders/staff-queries";
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
  const order = await withUserTransaction(session, (client) => getStaffOrder(client, d.id));
  const canWrite = hasPermission(session, "consultations:write");
  const completedCount = members.filter((m) => m.status === "completed").length;
  // Empresa (PJ) primeiro, depois sócios (PF).
  const ordered = [...members].sort((a, b2) =>
    a.type === b2.type ? 0 : a.type === "PJ" ? -1 : 1
  );

  const canGenerate = members.some((m) => m.type === "PJ" && m.status === "completed");
  const hasCompleted = members.some((m) => m.status === "completed");

  const roleOf = (type: "PJ" | "PF") => (type === "PJ" ? "Empresa" : d.kind === "PF" ? "Titular" : "Sócio");

  return (
    <div className="space-y-4">
      <DetailHeader title="Pesquisa" backHref="/dossiers" backLabel="Voltar para Pesquisas" />

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="break-words text-xl font-bold">{d.holder_name}</h2>
          <p className="text-sm text-muted-foreground">
            {DOSSIER_KIND_LABEL[d.kind]} · {completedCount}/{members.length} consultas concluídas
          </p>
        </div>
        <div>
          <DossierStatusBadge status={d.status} />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
        </div>
      </div>

      {/* Sem pedido (dados antigos de desenvolvimento): o painel não aparece */}
      {order && (
        <OrderPanel
          order={order}
          canWrite={canWrite && !session.supportSessionId}
          canRegisterPayment={hasPermission(session, "counter:write")}
          hasPartners={members.length > 1}
          pendingContacts={ordered
            .filter((m) => m.status === "pending_authorization")
            .map((m) => ({
              consultationId: m.id,
              name: m.document_name ?? "Titular sem nome",
              role: m.type === "PJ" ? "Empresa" : d.kind === "PF" ? "Titular" : "Sócio",
              maskedEmail: m.scr_email ? maskRecipient(m.scr_email) : null,
            }))}
        />
      )}

      {/* Consultas da pesquisa */}
      <Card>
        <CardContent className="p-0">
          <StackedList>
            {ordered.map((m) => (
              <StackedRow
                key={m.id}
                href={`/consultations/${m.id}`}
                title={m.document_name ?? "—"}
                meta={`${roleOf(m.type)} · ${m.type === "PJ" ? formatCNPJ(m.document) : formatCPF(m.document)} · ${formatDate(m.consulted_at)}`}
                status={<QueryStatusBadge status={m.status} />}
              />
            ))}
            {ordered.length === 0 && (
              <li className="p-4 text-center text-sm text-muted-foreground">Nenhuma consulta nesta pesquisa.</li>
            )}
          </StackedList>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Papel</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Consultado em</TableHead>
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
                    <TableCell>{roleOf(m.type)}</TableCell>
                    <TableCell className="font-mono">
                      {m.type === "PJ" ? formatCNPJ(m.document) : formatCPF(m.document)}
                    </TableCell>
                    <TableCell>
                      <QueryStatusBadge status={m.status} />
                    </TableCell>
                    <TableCell>{formatDate(m.consulted_at)}</TableCell>
                  </TableRow>
                ))}
                {ordered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Nenhuma consulta nesta pesquisa.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
