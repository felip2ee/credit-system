import Link from "next/link";

import { SidebarBrand } from "@/components/layout/brand-mark";
import { SUPERADMIN_NAV_ITEMS } from "@/components/layout/nav-items";

export function SuperadminNav() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <SidebarBrand label="Superadmin" />
      <nav className="flex-1 space-y-1 p-3">
        {SUPERADMIN_NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-11 items-center rounded-md px-3 py-2 text-base font-bold hover:bg-sidebar-accent/60"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
