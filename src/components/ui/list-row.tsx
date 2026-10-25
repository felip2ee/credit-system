import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ListRowProps {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  // À direita; números com tabular-nums.
  value?: ReactNode;
  href?: string;
  // Fundo cinza e cantos de cartão (linha solta); sem isso a linha vai dentro de um Card.
  boxed?: boolean;
  className?: string;
}

// Linha de lançamento/transação: ícone circular cinza, título, subtítulo e valor à direita.
export function ListRow({ icon: Icon, title, subtitle, value, href, boxed = false, className }: ListRowProps) {
  const cls = cn(
    "flex min-h-14 items-center gap-3 px-4 py-3",
    boxed && "rounded-card bg-muted",
    href && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  const body = (
    <>
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-primary">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-base font-bold">{title}</span>
        {subtitle && <span className="block break-words text-base text-muted-foreground">{subtitle}</span>}
      </span>
      {value && <span className="shrink-0 text-right text-base font-bold tabular-nums">{value}</span>}
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
