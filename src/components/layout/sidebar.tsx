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

import { visibleNavItems, type NavItem } from "@/components/layout/nav-items";
import type { Permission } from "@/lib/db/permissions";
import { cn } from "@/lib/utils";

type SidebarItem = NavItem & { icon: React.ComponentType<{ className?: string }> };

const NAV_ITEMS: SidebarItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dossiers", label: "Pesquisas", icon: Search },
  { href: "/holders", label: "Titulares", icon: Users },
  { href: "/scr", label: "Autorizações SCR", icon: ShieldCheck },
  { href: "/settings/catalog", label: "Catálogo", icon: PackageSearch },
  { href: "/settings/wallet", label: "Carteira", icon: Wallet },
  { href: "/settings/counter-payments", label: "Pagamentos de balcão", icon: Banknote, permission: "counter:read" },
  { href: "/settings/payouts", label: "Repasses", icon: HandCoins, permission: "payout:read" },
  { href: "/afiliados", label: "Afiliados", icon: Share2, permission: "affiliates:manage" },
  { href: "/settings", label: "Configurações", icon: Settings },
];

const SETTINGS_SUBPAGES = ["/settings/catalog", "/settings/wallet", "/settings/counter-payments", "/settings/payouts"];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/settings" && SETTINGS_SUBPAGES.some((sub) => pathname.startsWith(sub))) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ permissions }: { permissions: readonly Permission[] }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-6 text-lg font-semibold">
        <span className="h-2.5 w-2.5 rounded-full bg-sidebar-primary" />
        <span>
          Rainha <span className="text-sidebar-primary">Cred</span>
        </span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {visibleNavItems(NAV_ITEMS, permissions).map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
