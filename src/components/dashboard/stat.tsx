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
    <Card className="flex h-full items-center gap-4 p-5 transition-shadow hover:shadow-md">
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
        <Icon className="size-6" />
      </span>
      <div className="min-w-0">
        <p className="text-base text-muted-foreground">{label}</p>
        <p className="text-3xl font-bold leading-tight tabular-nums">{value}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
