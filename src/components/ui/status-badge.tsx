import { cn } from "@/lib/utils";

import { STATE_TONE_ICON, toneStyle, type StateTone } from "./state-tone";

export function StatusBadge({ tone, label, className }: { tone: StateTone; label: string; className?: string }) {
  const Icon = STATE_TONE_ICON[tone];
  return (
    <span
      style={toneStyle(tone)}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-bold admin:px-2.5 admin:py-0.5 admin:text-xs", className)}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", tone === "progress" && "motion-safe:animate-spin")} />
      {label}
    </span>
  );
}
