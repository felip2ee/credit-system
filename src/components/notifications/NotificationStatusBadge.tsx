import { Badge } from "@/components/ui/badge";
import type { NotificationStatus } from "@/lib/notifications/types";

import { NOTIFICATION_BADGE } from "./notification-logic";

export function NotificationStatusBadge({ status }: { status: NotificationStatus }) {
  const { label, variant } = NOTIFICATION_BADGE[status];
  return <Badge variant={variant}>{label}</Badge>;
}
