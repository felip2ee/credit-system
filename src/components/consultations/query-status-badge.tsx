import { Badge, type BadgeProps } from "@/components/ui/badge";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";

const VARIANT: Record<QueryStatus, BadgeProps["variant"]> = {
  pending_authorization: "secondary",
  authorized: "default",
  processing: "secondary",
  completed: "success",
  error: "destructive",
  rejected: "muted",
};

export function QueryStatusBadge({ status }: { status: QueryStatus }) {
  return <Badge variant={VARIANT[status]}>{QUERY_STATUS_LABEL[status]}</Badge>;
}
