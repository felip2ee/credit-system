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
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma notificação encontrada.</p>;
  return (
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
              <TableCell>{canRetryNotification(row.status, canWrite) && <RetryNotificationButton id={row.id} />}</TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
