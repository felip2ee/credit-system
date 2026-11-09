import Link from "next/link";

import { SidebarBrand } from "@/components/layout/brand-mark";
import { SUPERADMIN_NAV_ITEMS } from "@/components/layout/nav-items";

export function SuperadminNav() {
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Superadmin" />
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2.5">
        {SUPERADMIN_NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-10 items-center rounded-full px-3.5 py-2 text-sm font-bold hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
