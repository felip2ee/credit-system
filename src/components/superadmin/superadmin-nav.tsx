import Link from "next/link";

import { SidebarBrand } from "@/components/layout/brand-mark";
import { SUPERADMIN_NAV_ITEMS } from "@/components/layout/nav-items";

export function SuperadminNav() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Superadmin" />
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {SUPERADMIN_NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-11 items-center rounded-full px-4 py-2 text-base font-bold hover:bg-sidebar-accent/60"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
