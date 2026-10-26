import Link from "next/link";

import { cn } from "@/lib/utils";

export type Chip = { key: string; label: string; href: string };

// Chips de filtro como links (a URL guarda o filtro). Alvo de 44px.
export function FilterChips({ label, chips, active }: { label: string; chips: readonly Chip[]; active: string }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <Link
          key={c.key}
          href={c.href}
          aria-current={c.key === active ? "true" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-full border px-4 text-base font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            c.key === active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
          )}
        >
          {c.label}
        </Link>
      ))}
    </nav>
  );
}
