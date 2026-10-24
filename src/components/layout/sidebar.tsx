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
  Banknote,
  HandCoins,
  Share2,
} from "lucide-react";

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
  "/settings/counter-payments": Banknote,
  "/settings/payouts": HandCoins,
  "/afiliados": Share2,
  "/settings": Settings,
};

export function Sidebar({ permissions }: { permissions: readonly Permission[] }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand />
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
                "flex items-center gap-3 min-h-11 rounded-md px-3 py-2 text-base font-bold transition-colors",
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
    </aside>
  );
}
