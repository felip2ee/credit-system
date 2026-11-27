import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// Lista empilhada para telas estreitas: some a partir de `md`, onde a tabela assume.
export function StackedList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("divide-y divide-border md:hidden", className)}>{children}</ul>;
}

interface StackedRowProps {
  title: ReactNode;
  // Linha de apoio (tipo, documento, data). Quebra em vez de cortar.
  meta?: ReactNode;
  // Estado em selo, abaixo do apoio: nunca na coluna do valor, para o nome não espremer.
  status?: ReactNode;
  // Valor curto à direita.
  aside?: ReactNode;
  href?: string;
  // Ações da linha (botões): ficam fora do link.
  children?: ReactNode;
}

// Linha compacta: título quebra, selo abaixo, só um valor curto à direita.
export function StackedRow({ title, meta, status, aside, href, children }: StackedRowProps) {
  const body = (
    <>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block break-words text-base font-bold">{title}</span>
        {meta && <span className="block break-words text-sm text-muted-foreground">{meta}</span>}
        {status && <span className="flex flex-wrap items-center gap-1">{status}</span>}
      </span>
      {aside && <span className="shrink-0 text-right text-sm font-bold tabular-nums">{aside}</span>}
    </>
  );
  const rowClass = "flex min-h-14 items-start gap-3 px-4 py-3";
  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={cn(
            rowClass,
            "duration-fast ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {children && <div className="px-4 pb-3">{children}</div>}
    </li>
  );
}
