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
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatCNPJ, formatCPF, formatDateTime } from "@/lib/utils";

const ACTION_LABEL: Record<string, string> = {
  "bureau.consult": "Consulta ao bureau",
};

interface AuditRow {
  id: string;
  action: string;
  table_name: string | null;
  record_id: string | null;
  new_data: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  profiles: { full_name: string | null; email: string | null } | null;
}

// Formata o documento (CPF/CNPJ) guardado em new_data, quando houver.
function describeDocument(data: Record<string, unknown> | null): string {
  if (!data) return "—";
  const doc = typeof data.document === "string" ? data.document : null;
  const type = typeof data.type === "string" ? data.type : null;
  if (!doc) return "—";
  return type === "PJ" ? formatCNPJ(doc) : formatCPF(doc);
}

export default async function AuditPage() {
  const profile = await getCurrentProfile();
  if (profile?.role !== "admin") {
    redirect("/settings");
  }

  const supabase = createClient();
  const { data } = await supabase
    .from("audit_logs")
    .select(
      "id, action, table_name, record_id, new_data, ip_address, created_at, profiles(full_name, email)"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  const logs = (data ?? []) as unknown as AuditRow[];

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
                    {log.profiles?.full_name ?? log.profiles?.email ?? "—"}
                  </TableCell>
                  <TableCell>{ACTION_LABEL[log.action] ?? log.action}</TableCell>
                  <TableCell>{describeDocument(log.new_data)}</TableCell>
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
