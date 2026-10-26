import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import type { QueryStatus } from "@/types/app";

export function QueryStatusBadge({ status }: { status: QueryStatus }) {
  const { tone, label } = statusInfo("consultation", status, "staff");
  return <StatusBadge tone={tone} label={label} />;
}
