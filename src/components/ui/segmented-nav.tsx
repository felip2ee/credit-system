import Link from "next/link";

import { cn } from "@/lib/utils";

interface SegmentedNavProps {
  label: string;
  items: readonly { key: string; label: string; href: string }[];
  activeKey: string;
  // Valor de aria-current da opção ativa: "page" quando as opções são páginas/abas.
  current?: "page" | "true";
  className?: string;
}

// Filtro em "segmented control" para o painel admin: contêiner pílula branco com borda; opção ativa amarela.
// Cada opção é um link (a URL guarda o filtro). Altura 44 px no celular e 36 px (h-9) de md para cima.
export function SegmentedNav({ label, items, activeKey, current = "true", className }: SegmentedNavProps) {
  return (
    <nav
      aria-label={label}
      className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-card p-0.5", className)}
    >
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? current : undefined}
            className={cn(
              "inline-flex h-11 md:h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
