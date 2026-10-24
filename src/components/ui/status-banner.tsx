import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { STATE_TONE_ICON, toneRole, toneStyle, type StateTone } from "./state-tone";

interface StatusBannerProps {
  tone: StateTone;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function StatusBanner({ tone, title, description, action, className }: StatusBannerProps) {
  const Icon = STATE_TONE_ICON[tone];
  return (
    <div
      role={toneRole(tone)}
      style={toneStyle(tone)}
      className={cn("flex flex-col gap-3 rounded-lg border-2 p-4 sm:flex-row sm:items-start", className)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-6 shrink-0", tone === "progress" && "motion-safe:animate-spin")} />
      <div className="flex-1 space-y-1">
        <p className="text-base font-bold">{title}</p>
        {description && <div className="text-base">{description}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
