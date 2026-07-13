import { Badge } from "@/components/ui/badge";
import { OPPORTUNITY_STATUS_LABEL, type OpportunityStatus } from "@/types/app";

const VARIANT: Record<
  OpportunityStatus,
  "default" | "secondary" | "destructive" | "success" | "muted" | "outline"
> = {
  new: "muted",
  documentation: "secondary",
  analysis: "secondary",
  sent_to_partner: "default",
  approved: "success",
  rejected: "destructive",
  completed: "success",
  cancelled: "muted",
};

export function OpportunityStatusBadge({
  status,
}: {
  status: OpportunityStatus;
}) {
  return (
    <Badge variant={VARIANT[status]}>{OPPORTUNITY_STATUS_LABEL[status]}</Badge>
  );
}
