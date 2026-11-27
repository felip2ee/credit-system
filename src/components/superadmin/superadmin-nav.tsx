"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { Banknote, Bell, Bot, Building2, Clock, FileText, HandCoins, Package, Percent, Settings, Share2, ShieldCheck } from "lucide-react";

import { SidebarBrand } from "@/components/layout/brand-mark";
import { SUPERADMIN_NAV_ITEMS, groupNavItems, isNavActive } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "/superadmin": Building2,
  "/superadmin/saques": HandCoins,
  "/superadmin/payouts": Banknote,
  "/superadmin/nfse": FileText,
  "/superadmin/notifications": Bell,
  "/superadmin/products": Package,
  "/superadmin/settings": Settings,
  "/superadmin/settings/comissao": Percent,
  "/superadmin/settings/repasses": Clock,
  "/superadmin/settings/afiliados": Share2,
  "/superadmin/settings/scr": ShieldCheck,
  "/superadmin/settings/prompts": Bot,
};

export function SuperadminNav() {
  const pathname = usePathname();
  const navId = useId();

  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Superadmin" />
      <nav aria-label="Principal" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5">
        {groupNavItems(SUPERADMIN_NAV_ITEMS).map((group) => (
          <div key={group.title ?? "todos"}>
            {group.title && (
              <h2 id={`${navId}-${group.title}`} className="px-3.5 pb-1 text-xs font-bold uppercase tracking-wide">
                {group.title}
              </h2>
            )}
            <ul aria-labelledby={group.title ? `${navId}-${group.title}` : undefined} className="space-y-0.5">
              {group.items.map((item) => {
                const active = isNavActive(pathname, item.href);
                const Icon = ICONS[item.href];
                return (
                  <li key={item.href}>
                    <Link
                      aria-current={active ? "page" : undefined}
                      href={item.href}
                      className={cn(
                        "flex min-h-10 items-center gap-2.5 rounded-full px-3.5 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-sidebar-primary text-sidebar-primary-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}
                    >
                      <Icon aria-hidden className="size-[18px] shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
