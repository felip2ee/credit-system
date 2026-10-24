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
    <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-input p-8 text-center">
      <Icon aria-hidden className="size-10 text-[#009C97]" />
      <p className="text-lg font-bold">{title}</p>
      {description && <p className="max-w-prose text-base text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
