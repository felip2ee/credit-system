import type { BadgeProps } from "@/components/ui/badge";
import type { PayoutStatus } from "@/lib/payouts/queries";

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  open: "Aberto",
  paid: "Pago",
  cancelled: "Cancelado",
};

export const PAYOUT_STATUS_VARIANT: Record<PayoutStatus, BadgeProps["variant"]> = {
  open: "secondary",
  paid: "success",
  cancelled: "muted",
};
