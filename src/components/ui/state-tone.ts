import { AlertTriangle, CheckCircle2, Clock, Info, Loader2, XCircle, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";

import type { StateName } from "@/lib/brand/tokens";

export type StateTone = StateName;

export const STATE_TONE_ICON: Record<StateTone, LucideIcon> = {
  success: CheckCircle2,
  waiting: Clock,
  progress: Loader2,
  attention: AlertTriangle,
  danger: XCircle,
  neutral: Info,
};

// Atenção e erro interrompem o leitor de tela; os demais esperam a vez.
export function toneRole(tone: StateTone): "alert" | "status" {
  return tone === "attention" || tone === "danger" ? "alert" : "status";
}

// Tons claros de STATE_COLORS, pelas variáveis --st-<tom>-* (globals.css).
export function toneStyle(tone: StateTone): CSSProperties {
  return {
    backgroundColor: `var(--st-${tone}-bg)`,
    color: `var(--st-${tone}-fg)`,
    borderColor: `var(--st-${tone}-border)`,
  };
}

export type StepState = "done" | "current" | "todo" | "failed";
export interface StepItem {
  label: string;
  state: StepState;
}

export function stepperAnnouncement(steps: StepItem[]): string {
  const current = steps.find((s) => s.state === "current");
  if (current) return `Agora: ${current.label}`;
  const failed = steps.find((s) => s.state === "failed");
  return failed ? `Falhou: ${failed.label}` : "";
}
