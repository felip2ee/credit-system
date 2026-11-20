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
  Ticket,
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
  "/settings/cupons": Ticket,
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
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Admin" />
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2.5">
        {visibleNavItems(DASHBOARD_NAV_ITEMS, permissions).map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = ICONS[item.href];
          return (
            <Link
              key={item.href}
              aria-current={active ? "page" : undefined}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 min-h-10 rounded-full px-3.5 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon aria-hidden className="size-[18px] shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-0.5 border-t border-sidebar-border p-2.5">
        <p className="truncate px-3.5 text-sm font-bold">{name}</p>
        {email && <p className="truncate px-3.5 text-xs text-sidebar-foreground">{email}</p>}
        <form action={signOut}>
          <button
            type="submit"
            className="flex min-h-10 w-full items-center gap-2.5 rounded-full px-3.5 py-2 text-sm font-bold text-sidebar-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut aria-hidden className="size-[18px] shrink-0" />
            Sair
          </button>
        </form>
      </div>
    </aside>
  );
}
