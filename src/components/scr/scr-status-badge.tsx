import { Badge, type BadgeProps } from "@/components/ui/badge";
import { SCR_STATUS_LABEL, type ScrStatus } from "@/types/app";

const VARIANT: Record<ScrStatus, BadgeProps["variant"]> = {
  pending: "secondary",
  authorized: "success",
  not_authorized: "destructive",
  expired: "muted",
};

export function ScrStatusBadge({ status }: { status: ScrStatus }) {
  return <Badge variant={VARIANT[status]}>{SCR_STATUS_LABEL[status]}</Badge>;
}
