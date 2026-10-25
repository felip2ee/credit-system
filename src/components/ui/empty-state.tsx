import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-hero bg-surface p-8 text-center">
      <span aria-hidden className="flex size-16 items-center justify-center rounded-full bg-brand-soft">
        <Icon className="size-8 text-primary" />
      </span>
      <p className="text-lg font-bold">{title}</p>
      {description && <p className="max-w-prose text-base text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
