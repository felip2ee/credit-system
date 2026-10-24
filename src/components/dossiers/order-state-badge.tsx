import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import type { OrderState } from "@/lib/orders/types";

export function OrderStateBadge({ state }: { state: OrderState }) {
  const { tone, label } = statusInfo("order", state, "staff");
  return <StatusBadge tone={tone} label={label} />;
}
