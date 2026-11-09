import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// Grade de ações rápidas: tile com ícone e rótulo embaixo.
export function QuickActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn("grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4", className)}>{children}</ul>;
}

interface QuickActionProps {
  icon: LucideIcon;
  label: string;
  // Com href vira link; com onClick vira botão.
  href?: string;
  onClick?: () => void;
  // Ação principal: tile verde com ícone branco.
  active?: boolean;
}

export function QuickAction({ icon: Icon, label, href, onClick, active = false }: QuickActionProps) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex size-14 items-center justify-center rounded-hero transition-transform group-active:scale-95 motion-reduce:group-active:scale-100",
          active ? "bg-primary text-primary-foreground" : "bg-card text-primary border border-border",
        )}
      >
        <Icon className="size-6" />
      </span>
      <span className="text-center text-base leading-tight">{label}</span>
    </>
  );
  const cls =
    "group flex min-h-14 w-full flex-col items-center gap-2 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  return (
    <li>
      {href ? (
        <Link href={href} className={cls}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={cls}>
          {body}
        </button>
      )}
    </li>
  );
}
