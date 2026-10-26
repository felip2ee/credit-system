"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  PackageSearch,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  Share2,
  LogOut,
} from "lucide-react";

import { signOut } from "@/actions/auth";
import { SidebarBrand } from "@/components/layout/brand-mark";
import { DASHBOARD_NAV_ITEMS, isNavActive, visibleNavItems } from "@/components/layout/nav-items";
import type { Permission } from "@/lib/db/permissions";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "/": LayoutDashboard,
  "/dossiers": Search,
  "/holders": Users,
  "/scr": ShieldCheck,
  "/settings/catalog": PackageSearch,
  "/settings/wallet": Wallet,
  "/afiliados": Share2,
  "/settings": Settings,
};

export function Sidebar({
  permissions,
  name,
  email,
}: {
  permissions: readonly Permission[];
  name: string;
  email: string | null;
}) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Admin" />
      <nav className="flex-1 space-y-1 p-3">
        {visibleNavItems(DASHBOARD_NAV_ITEMS, permissions).map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = ICONS[item.href];
          return (
            <Link
              key={item.href}
              aria-current={active ? "page" : undefined}
              href={item.href}
              className={cn(
                "flex items-center gap-3 min-h-11 rounded-full px-4 py-2 text-base font-bold transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-1 border-t border-sidebar-border p-3">
        <p className="truncate px-4 text-base font-bold">{name}</p>
        {email && <p className="truncate px-4 text-sm text-sidebar-foreground/70">{email}</p>}
        <form action={signOut}>
          <button
            type="submit"
            className="flex min-h-11 w-full items-center gap-3 rounded-full px-4 py-2 text-base font-bold text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut aria-hidden className="h-5 w-5" />
            Sair
          </button>
        </form>
      </div>
    </aside>
  );
}
