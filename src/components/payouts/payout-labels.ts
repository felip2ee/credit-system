import type { StateTone } from "@/components/ui/state-tone";
import type { PayoutStatus } from "@/lib/payouts/queries";

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  open: "Aberto",
  paid: "Pago",
  cancelled: "Cancelado",
};

export const PAYOUT_STATUS_TONE: Record<PayoutStatus, StateTone> = {
  open: "waiting",
  paid: "success",
  cancelled: "neutral",
};
