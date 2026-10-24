import { Check, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { stepperAnnouncement, type StepItem } from "./state-tone";

const MARK_CLASS: Record<StepItem["state"], string> = {
  done: "border-primary bg-primary text-primary-foreground",
  current: "border-primary bg-background text-primary",
  todo: "border-input bg-background text-muted-foreground",
  failed: "border-destructive bg-destructive text-destructive-foreground",
};

export function Stepper({ steps }: { steps: StepItem[] }) {
  const announcement = stepperAnnouncement(steps);
  return (
    <div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ol className="flex flex-col gap-4 md:flex-row md:gap-6">
        {steps.map((step, i) => (
          <li
            key={step.label}
            aria-current={step.state === "current" ? "step" : undefined}
            className="flex items-start gap-3 md:flex-1 md:flex-col"
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold",
                MARK_CLASS[step.state],
              )}
            >
              {step.state === "done" ? (
                <Check aria-hidden className="size-4" strokeWidth={3} />
              ) : step.state === "failed" ? (
                <X aria-hidden className="size-4" strokeWidth={3} />
              ) : (
                i + 1
              )}
            </span>
            <span className="text-base">
              {step.state === "current" && <strong className="block">Agora:</strong>}
              {step.state === "failed" && <strong className="block">Falhou:</strong>}
              <span className={cn(step.state === "todo" && "text-muted-foreground")}>{step.label}</span>
              {step.state === "done" && <span className="sr-only"> (concluído)</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
