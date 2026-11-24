"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Link2, PlusCircle, Receipt } from "lucide-react";

import { cn } from "@/lib/utils";

export const ADMIN_APP_NAV = [
  { href: "/admin", label: "Início", icon: Home },
  { href: "/admin/consulta", label: "Nova consulta", icon: PlusCircle },
  { href: "/admin/cobrancas", label: "Cobranças", icon: Receipt },
  { href: "/admin/links", label: "Links", icon: Link2 },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
}

// Barra superior no desktop e barra de abas fixa no celular. A mesma lista alimenta as duas.
export function AdminNav({ variant }: { variant: "top" | "bottom" }) {
  const pathname = usePathname();

  if (variant === "top") {
    return (
      <nav aria-label="Principal" className="hidden items-center gap-1 md:flex">
        {ADMIN_APP_NAV.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(pathname, href) ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center rounded-full px-3.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive(pathname, href)
                ? "bg-primary text-primary-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {ADMIN_APP_NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            <Icon aria-hidden className="size-5" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
