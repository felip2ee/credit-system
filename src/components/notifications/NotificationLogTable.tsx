import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NotificationRow } from "@/lib/notifications/queries";
import { formatDateTime } from "@/lib/utils";

import { CHANNEL_LABEL, canRetryNotification } from "./notification-logic";
import { NotificationStatusBadge } from "./NotificationStatusBadge";
import { RetryNotificationButton } from "./RetryNotificationButton";

export interface NotificationLogTableProps {
  rows: NotificationRow[];
  bureauNames: Map<string, string>;
  canWrite: boolean;
}

export function NotificationLogTable({ rows, bureauNames, canWrite }: NotificationLogTableProps) {
  const retryButton = (row: NotificationRow) =>
    canRetryNotification(row.status, canWrite, row.retryable) && (
      <RetryNotificationButton
        id={row.id}
        label={`Tentar de novo o envio ${row.templateKey ?? "sem template"} para ${row.recipientMasked}`}
      />
    );
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma notificação encontrada.</p>;
  return (
    <>
    <ul className="space-y-3 md:hidden" aria-label="Log de notificações">
      {rows.map((row) => (
        <li key={row.id}>
          <Card className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{formatDateTime(row.createdAt)}</span>
              <NotificationStatusBadge status={row.status} />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Bureau</dt>
              <dd className="break-words">{row.bureauId ? (bureauNames.get(row.bureauId) ?? "—") : "Plataforma"}</dd>
              <dt className="text-muted-foreground">Template</dt>
              <dd className="break-all font-mono text-xs">{row.templateKey ?? "—"}</dd>
              <dt className="text-muted-foreground">Canal</dt>
              <dd>{CHANNEL_LABEL[row.channel]}</dd>
              <dt className="text-muted-foreground">Destinatário</dt>
              <dd className="break-all font-mono text-xs">{row.recipientMasked}</dd>
              <dt className="text-muted-foreground">Tentativas</dt>
              <dd>
                {row.attempts}/{row.maxAttempts}
              </dd>
              <dt className="text-muted-foreground">Último erro</dt>
              <dd className="break-all font-mono text-xs">{row.lastErrorCode ?? "—"}</dd>
            </dl>
            {retryButton(row)}
          </Card>
        </li>
      ))}
    </ul>
    <Card className="hidden overflow-hidden md:block">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Data</TableHead>
          <TableHead>Bureau</TableHead>
          <TableHead>Template</TableHead>
          <TableHead>Canal</TableHead>
          <TableHead>Destinatário</TableHead>
          <TableHead>Estado</TableHead>
          <TableHead>Tentativas</TableHead>
          <TableHead>Último erro</TableHead>
          {canWrite && <TableHead>Ação</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{formatDateTime(row.createdAt)}</TableCell>
            <TableCell>{row.bureauId ? (bureauNames.get(row.bureauId) ?? "—") : "Plataforma"}</TableCell>
            <TableCell className="font-mono text-xs">{row.templateKey ?? "—"}</TableCell>
            <TableCell>{CHANNEL_LABEL[row.channel]}</TableCell>
            <TableCell className="font-mono text-xs">{row.recipientMasked}</TableCell>
            <TableCell>
              <NotificationStatusBadge status={row.status} />
            </TableCell>
            <TableCell>
              {row.attempts}/{row.maxAttempts}
            </TableCell>
            <TableCell className="font-mono text-xs">{row.lastErrorCode ?? "—"}</TableCell>
            {canWrite && (
              <TableCell>{retryButton(row)}</TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </Card>
    </>
  );
}
