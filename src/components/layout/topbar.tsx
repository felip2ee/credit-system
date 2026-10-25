import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { MobileBrand } from "@/components/layout/brand-mark";
import { MobileNav } from "@/components/layout/mobile-nav";
import type { NavItem } from "@/components/layout/nav-items";
import { Button } from "@/components/ui/button";
import type { Permission } from "@/lib/db/permissions";

interface TopbarProps {
  email: string | null;
  navItems: readonly NavItem[];
  permissions?: readonly Permission[];
}

export function Topbar({ email, navItems, permissions }: TopbarProps) {
  return (
    <header className="flex min-h-16 items-center justify-between gap-2 border-b border-border bg-background px-4 md:px-6">
      <div className="flex items-center gap-3 md:hidden">
        <MobileBrand />
      </div>
      <div className="hidden truncate text-sm text-muted-foreground md:block">{email}</div>
      <div className="flex items-center gap-2">
        <div className="md:hidden">
          <MobileNav items={navItems} permissions={permissions} />
        </div>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            <LogOut aria-hidden className="h-4 w-4" />
            Sair
          </Button>
        </form>
      </div>
    </header>
  );
}
