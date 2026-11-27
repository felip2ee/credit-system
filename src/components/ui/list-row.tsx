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
  // Cor do ícone (ex.: entrada/saída no extrato); padrão text-primary.
  iconClassName?: string;
  className?: string;
}

// O container é a linha: rem acompanha a fonte do usuário, então só a fonte ampliada (linha menor que 12rem) desfaz o corte.
const LARGE_TEXT_WRAP = "[@container_(max-width:12rem)]:whitespace-normal [@container_(max-width:12rem)]:[overflow-wrap:anywhere]";

// Linha de lançamento/transação: ícone circular cinza, título, subtítulo e valor à direita.
export function ListRow({ icon: Icon, title, subtitle, value, href, boxed = false, iconClassName, className }: ListRowProps) {
  const cls = cn(
    "flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 [container-type:inline-size] admin:min-h-12 admin:py-2.5",
    boxed && "rounded-card bg-muted",
    href && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  const body = (
    <>
      <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-full bg-accent admin:size-9 admin:rounded-[10px]", iconClassName ?? "text-primary")}>
        <Icon className="size-5 admin:size-[18px]" />
      </span>
      <span className="min-w-0 flex-[1_1_6rem]">
        <span className={cn("block truncate text-base font-bold admin:text-sm", LARGE_TEXT_WRAP)}>{title}</span>
        {subtitle && <span className={cn("block truncate text-base text-muted-foreground admin:text-[13px]", LARGE_TEXT_WRAP)}>{subtitle}</span>}
      </span>
      {value && <span className="ml-auto shrink-0 whitespace-nowrap text-right text-base font-bold admin:text-sm tabular-nums">{value}</span>}
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
