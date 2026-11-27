import { PackageSearch, ScrollText, ShieldCheck, Store, Ticket, Users, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { redirect } from "next/navigation";

import { SETTINGS_PAGES, visibleNavItems } from "@/components/layout/nav-items";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { getRequiredSession } from "@/lib/auth/session";
import { permissionsFor } from "@/lib/db/permissions";

const ICONS: Record<string, LucideIcon> = {
  "/settings/security": ShieldCheck,
  "/settings/users": Users,
  "/settings/audit": ScrollText,
  "/settings/catalog": PackageSearch,
  "/settings/cupons": Ticket,
  "/settings/wallet": Wallet,
  "/settings/counter-payments": Store,
};

export default async function SettingsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  const pages = visibleNavItems(SETTINGS_PAGES, permissionsFor(session));

  return (
    <div>
      <PageHeader title="Configurações" description="Escolha o que você quer ajustar" />

      <Card className="divide-y divide-border overflow-hidden">
        {pages.map((page) => (
          <ListRow
            key={page.href}
            href={page.href}
            icon={ICONS[page.href]}
            title={page.label}
            subtitle={<span className="block whitespace-normal">{page.description}</span>}
          />
        ))}
      </Card>
    </div>
  );
}
