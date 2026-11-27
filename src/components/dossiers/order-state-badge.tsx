import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import type { OrderMode, OrderState } from "@/lib/orders/types";

export function OrderStateBadge({ state, mode, revoked }: { state: OrderState; mode?: OrderMode; revoked?: boolean }) {
  const { tone, label } = statusInfo("order", state, "staff", mode, revoked);
  return <StatusBadge tone={tone} label={label} />;
}
