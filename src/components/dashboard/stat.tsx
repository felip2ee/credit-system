import Link from "next/link";

import { Card } from "@/components/ui/card";

interface StatProps {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
}

export function Stat({ label, value, hint, icon: Icon, href }: StatProps) {
  const body = (
    <Card className="flex h-full items-center gap-3 p-4 transition-shadow hover:shadow-md">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-soft text-brand-soft-foreground">
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold leading-tight tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
