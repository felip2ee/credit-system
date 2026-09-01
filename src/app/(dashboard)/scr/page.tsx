import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { ScrStatusBadge } from "@/components/scr/scr-status-badge";
import { ScrRowActions } from "@/components/scr/scr-row-actions";
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
import { listScrAuthorizations } from "@/lib/scr/queries";
import { cn, formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

type Tab = "pending" | "granted" | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pendentes" },
  { key: "granted", label: "Concedidas" },
  { key: "history", label: "Histórico" },
];

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function fmtDoc(type: string, doc: string) {
  return type === "PJ" ? formatCNPJ(doc) : formatCPF(doc);
}

export default async function ScrPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const tab: Tab =
    searchParams.tab === "granted" || searchParams.tab === "history"
      ? searchParams.tab
      : "pending";

  const session = await getRequiredSession();
  if (!hasPermission(session.role, "consultations:read")) return null;
  const rows = await listScrAuthorizations({ userId: session.userId, role: session.role }, tab === "pending" ? "pending" : tab === "granted" ? "authorized" : undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Autorizações SCR"
        description="Consentimento dos consultados — autogestão Rainha do Crédito (termo + código por e-mail)"
      />

      <div className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/scr?tab=${t.key}`}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-medium",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                {tab === "pending" && (
                  <>
                    <TableHead>Enviado em</TableHead>
                    <TableHead>Aguardando</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </>
                )}
                {tab === "granted" && (
                  <>
                    <TableHead>Aceite em</TableHead>
                    <TableHead>Validade</TableHead>
                  </>
                )}
                {tab === "history" && (
                  <>
                    <TableHead>Status</TableHead>
                    <TableHead>Enviado em</TableHead>
                    <TableHead>Última verificação</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const waiting = daysSince(r.requested_at);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono">
                      {fmtDoc(r.type, r.document)}
                    </TableCell>
                    <TableCell>{r.name ?? "—"}</TableCell>
                    <TableCell>{r.type}</TableCell>

                    {tab === "pending" && (
                      <>
                        <TableCell>{formatDate(r.requested_at)}</TableCell>
                        <TableCell
                          className={cn(waiting > 3 && "text-destructive")}
                        >
                          {waiting} {waiting === 1 ? "dia" : "dias"}
                        </TableCell>
                        <TableCell>
                          <ScrRowActions id={r.id} />
                        </TableCell>
                      </>
                    )}

                    {tab === "granted" && (
                      <>
                        <TableCell>{formatDate(r.authorized_at)}</TableCell>
                        <TableCell>{formatDate(r.expires_at)}</TableCell>
                      </>
                    )}

                    {tab === "history" && (
                      <>
                        <TableCell>
                          <ScrStatusBadge status={r.status} />
                        </TableCell>
                        <TableCell>{formatDate(r.requested_at)}</TableCell>
                        <TableCell>{formatDate(r.last_checked_at)}</TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    Nenhum registro.
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
