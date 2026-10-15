// Lógica pura das telas de notificação. Client-safe: só importa tipos.
import type { NotificationStatus } from "@/lib/notifications/queries";

export type NotificationBadgeVariant = "secondary" | "success" | "destructive" | "muted";

export const NOTIFICATION_BADGE: Record<NotificationStatus, { label: string; variant: NotificationBadgeVariant }> = {
  pending: { label: "Na fila", variant: "secondary" },
  sending: { label: "Na fila", variant: "secondary" },
  sent: { label: "Enviado", variant: "muted" },
  delivered: { label: "Entregue", variant: "success" },
  read: { label: "Entregue", variant: "success" },
  failed: { label: "Falhou", variant: "destructive" },
  suppressed: { label: "Bloqueado (opt-out)", variant: "muted" },
};

// "Tentar de novo" só para falha, e só para superadmin fora de suporte.
export function canRetryNotification(status: NotificationStatus, canWrite: boolean): boolean {
  return canWrite && status === "failed";
}

export const CHANNEL_LABEL = { email: "E-mail", whatsapp: "WhatsApp" } as const;
