import Link from "next/link";

import { StackedList } from "@/components/dashboard/stacked-list";
import { PageHeader } from "@/components/layout/page-header";
import { ScrHistoryRow, ScrSendHistory } from "@/components/scr/scr-send-history";
import { NotificationStatusBadge } from "@/components/notifications/NotificationStatusBadge";
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
  if (!hasPermission(session, "consultations:read")) return null;
  const rows = await listScrAuthorizations(session, tab === "pending" ? "pending" : tab === "granted" ? "authorized" : undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Autorizações SCR"
        description="Consentimento dos consultados — autogestão Rainha Cred (termo + código por e-mail)"
      />

      <div className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/scr?tab=${t.key}`}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
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
          <StackedList>
            {rows.map((r) => {
              const waiting = daysSince(r.requested_at);
              return (
                <ScrHistoryRow key={r.id} id={r.id} stacked>
                  <div className="space-y-1">
                    <p className="break-words text-base font-bold">{r.name ?? "—"}</p>
                    <p className="break-words text-sm text-muted-foreground">
                      {r.type} · <span className="font-mono">{fmtDoc(r.type, r.document)}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-1">
                      <ScrSendHistory status={r.status} />
                    </div>
                    {tab === "pending" && r.lastNotificationStatus && (
                      <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                        Último envio:
                        <NotificationStatusBadge status={r.lastNotificationStatus} />
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      {tab === "pending" && (
                        <>
                          Enviado em {formatDate(r.requested_at)} ·{" "}
                          <span className={cn(waiting > 3 && "font-bold text-destructive")}>
                            aguardando {waiting} {waiting === 1 ? "dia" : "dias"}
                            {waiting > 3 && " (atrasado)"}
                          </span>
                        </>
                      )}
                      {tab === "granted" && (
                        <>
                          Aceite em {formatDate(r.authorized_at)} · validade {formatDate(r.expires_at)}
                        </>
                      )}
                      {tab === "history" && (
                        <>
                          Enviado em {formatDate(r.requested_at)} · última verificação {formatDate(r.last_checked_at)}
                        </>
                      )}
                    </p>
                  </div>
                  {tab === "pending" && (
                    <div className="mt-2">
                      <ScrRowActions id={r.id} />
                    </div>
                  )}
                </ScrHistoryRow>
              );
            })}
            {rows.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">Nenhum registro.</li>}
          </StackedList>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Documento</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Tipo</TableHead>
                  {tab === "pending" && (
                    <>
                      <TableHead>Status</TableHead>
                      <TableHead>Enviado em</TableHead>
                      <TableHead>Aguardando</TableHead>
                      <TableHead>Último envio</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </>
                  )}
                  {tab === "granted" && (
                    <>
                      <TableHead>Status</TableHead>
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
                    <ScrHistoryRow key={r.id} id={r.id}>
                      <TableCell className="font-mono">
                        {fmtDoc(r.type, r.document)}
                      </TableCell>
                      <TableCell>{r.name ?? "—"}</TableCell>
                      <TableCell>{r.type}</TableCell>

                      {tab === "pending" && (
                        <>
                          <TableCell><ScrSendHistory status={r.status} /></TableCell>
                          <TableCell>{formatDate(r.requested_at)}</TableCell>
                          <TableCell
                            className={cn(waiting > 3 && "text-destructive")}
                          >
                            {waiting} {waiting === 1 ? "dia" : "dias"}
                          </TableCell>
                          <TableCell>
                            {r.lastNotificationStatus && (
                              <NotificationStatusBadge status={r.lastNotificationStatus} />
                            )}
                          </TableCell>
                          <TableCell>
                            <ScrRowActions id={r.id} />
                          </TableCell>
                        </>
                      )}

                      {tab === "granted" && (
                        <>
                          <TableCell><ScrSendHistory status={r.status} /></TableCell>
                          <TableCell>{formatDate(r.authorized_at)}</TableCell>
                          <TableCell>{formatDate(r.expires_at)}</TableCell>
                        </>
                      )}

                      {tab === "history" && (
                        <>
                          <TableCell>
                            <ScrSendHistory status={r.status} />
                          </TableCell>
                          <TableCell>{formatDate(r.requested_at)}</TableCell>
                          <TableCell>{formatDate(r.last_checked_at)}</TableCell>
                        </>
                      )}
                    </ScrHistoryRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-muted-foreground"
                    >
                      Nenhum registro.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
