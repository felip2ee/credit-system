import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import type { OrderMode, OrderState } from "@/lib/orders/types";

export function OrderStateBadge({ state, mode }: { state: OrderState; mode?: OrderMode }) {
  const { tone, label } = statusInfo("order", state, "staff", mode);
  return <StatusBadge tone={tone} label={label} />;
}
