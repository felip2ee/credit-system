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
  // Linha com texto longo: título e subtítulo quebram em vez de cortar, e no celular o valor desce para baixo do texto.
  wrap?: boolean;
  className?: string;
}

// Linha de lançamento/transação: ícone circular cinza, título, subtítulo e valor à direita.
export function ListRow({ icon: Icon, title, subtitle, value, href, boxed = false, iconClassName, wrap = false, className }: ListRowProps) {
  const cls = cn(
    "flex min-h-14 items-center gap-3 px-4 py-3 admin:min-h-12 admin:py-2.5",
    wrap && "max-sm:flex-wrap",
    boxed && "rounded-card bg-muted",
    href && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  const body = (
    <>
      <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-full bg-accent admin:size-9 admin:rounded-[10px]", iconClassName ?? "text-primary")}>
        <Icon className="size-5 admin:size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-base font-bold admin:text-sm", wrap ? "break-words" : "truncate")}>{title}</span>
        {subtitle && <span className={cn("block text-base text-muted-foreground admin:text-[13px]", wrap ? "break-words" : "truncate")}>{subtitle}</span>}
      </span>
      {value && <span className={cn("shrink-0 whitespace-nowrap text-right text-base font-bold admin:text-sm tabular-nums", wrap && "max-sm:basis-full max-sm:pl-14 max-sm:text-left")}>{value}</span>}
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
