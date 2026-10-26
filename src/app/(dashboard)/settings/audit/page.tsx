import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { auditActionLabel, describeAuditMetadata } from "@/lib/audit/labels";
import { listAuditLogs } from "@/lib/audit/read";
import { formatCNPJ, formatCPF, formatDateTime } from "@/lib/utils";

// Formata o documento (CPF/CNPJ) guardado nos metadados, quando houver.
function describeDocument(data: Record<string, unknown> | null): string {
  if (!data) return "—";
  const doc = typeof data.document === "string" ? data.document : null;
  const type = typeof data.type === "string" ? data.type : null;
  if (!doc) return "—";
  return type === "PJ" ? formatCNPJ(doc) : formatCPF(doc);
}

export default async function AuditPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "audit:read")) {
    redirect("/settings");
  }

  const logs = await listAuditLogs(session);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Auditoria"
        description="Trilha de acessos ao bureau — quem consultou qual documento, quando e de onde (LGPD)"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Últimos eventos ({logs.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data/hora</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Detalhes</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const action = auditActionLabel(log.action);
                const details = describeAuditMetadata(log.metadata);
                return (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(log.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {log.actor_name ?? log.actor_email ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          action.known ? "" : "text-xs text-muted-foreground"
                        }
                        title={action.raw}
                      >
                        {action.label}
                      </span>
                      {action.known && (
                        <span className="block break-all text-xs text-muted-foreground">
                          {action.raw}
                        </span>
                      )}
                      {log.supportSessionId && (
                        <Badge variant="muted" className="ml-2">
                          Suporte
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {describeDocument(log.metadata ?? log.new_data)}
                    </TableCell>
                    <TableCell className="min-w-[10rem] text-xs text-muted-foreground">
                      {details.length
                        ? details.map((d) => <div key={d}>{d}</div>)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.ip_address ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
              {logs.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    Nenhum evento de auditoria registrado ainda.
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
