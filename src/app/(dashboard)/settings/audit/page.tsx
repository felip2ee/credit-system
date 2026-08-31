import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { listAuditLogs } from "@/lib/audit/read";
import { formatCNPJ, formatCPF, formatDateTime } from "@/lib/utils";

const ACTION_LABEL: Record<string, string> = {
  "bureau.consult": "Consulta ao bureau",
};

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
  if (session.role !== "admin") {
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
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(log.created_at)}
                  </TableCell>
                  <TableCell className="font-medium">
                    {log.actor_name ?? log.actor_email ?? "—"}
                  </TableCell>
                  <TableCell>{ACTION_LABEL[log.action] ?? log.action}</TableCell>
                  <TableCell>
                    {describeDocument(log.metadata ?? log.new_data)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {log.ip_address ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {logs.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
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
