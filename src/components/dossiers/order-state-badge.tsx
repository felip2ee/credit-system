import { Badge, type BadgeProps } from "@/components/ui/badge";
import { ORDER_STATE_LABEL } from "@/lib/orders/labels";
import type { OrderState } from "@/lib/orders/types";

const VARIANT: Record<OrderState, BadgeProps["variant"]> = {
  awaiting_payment: "secondary",
  awaiting_authorization: "secondary",
  ready: "secondary",
  executing: "secondary",
  completed: "success",
  released: "success",
  failed: "destructive",
  cancelled: "muted",
};

export function OrderStateBadge({ state }: { state: OrderState }) {
  return <Badge variant={VARIANT[state]}>{ORDER_STATE_LABEL[state]}</Badge>;
}
