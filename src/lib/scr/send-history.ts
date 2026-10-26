import type { NotificationChannel, NotificationStatus } from "@/lib/notifications/types";

// Client-safe: sem pg. `recipientMasked` já vem mascarado do banco (e-mail "j***@dominio", telefone com 4 últimos dígitos).
export interface ScrSendRecord {
  id: string;
  channel: NotificationChannel;
  recipientMasked: string;
  status: NotificationStatus;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  sentAt: string | null;
}

// "Enviado" = saiu da fila para o provedor (sent_at preenchido). Pendente, substituído por reemissão e bloqueado por opt-out não contam.
export function countSent(records: readonly ScrSendRecord[]): number {
  return records.filter((r) => r.sentAt !== null).length;
}
