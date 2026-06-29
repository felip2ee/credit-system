import { Badge, type BadgeProps } from "@/components/ui/badge";
import { CRM_STATUS_LABEL, type CrmClientStatus } from "@/types/app";

const VARIANT: Record<CrmClientStatus, BadgeProps["variant"]> = {
  prospect: "secondary",
  active: "success",
  in_intermediation: "default",
  completed: "outline",
  inactive: "muted",
};

export function ClientStatusBadge({ status }: { status: CrmClientStatus }) {
  return <Badge variant={VARIANT[status]}>{CRM_STATUS_LABEL[status]}</Badge>;
}
