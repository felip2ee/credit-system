import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import type { ScrStatus } from "@/types/app";

export function ScrStatusBadge({ status }: { status: ScrStatus }) {
  const { tone, label } = statusInfo("scr", status, "staff");
  return <StatusBadge tone={tone} label={label} />;
}
