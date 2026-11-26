import Link from "next/link";
import { FilePlus2, HandCoins } from "lucide-react";

import { ClientOrderList } from "@/components/orders/client-order-list";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { listMyOrders } from "@/lib/orders/client-queries";
import { formatCurrency } from "@/lib/utils";

const RECENT_ORDERS = 5;

export default async function PortalHomePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session, "portal:read")) return null;
  const profile = await getCurrentProfile();
  const firstName = profile?.full_name.split(" ")[0] ?? "";
  const showAffiliate = hasPermission(session, "affiliates:read");
  const { orders, affiliate } = await withUserTransaction(session, async (client) => ({
    orders: await listMyOrders(client, RECENT_ORDERS),
    affiliate: showAffiliate ? await getMyAffiliateSummary(client) : null,
  }));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Olá{firstName ? `, ${firstName}` : ""}</h1>
      <Button asChild variant="cta" size="lg" glow className="w-full">
        <Link href="/portal/pesquisas/nova">
          <FilePlus2 aria-hidden />
          Nova pesquisa
        </Link>
      </Button>
      {orders.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Suas pesquisas" link={{ href: "/portal/pesquisas", label: "Ver todas" }} />
          <ClientOrderList orders={orders} />
        </section>
      )}
      {affiliate && (
        <section className="space-y-3">
          <SectionHeader title="Afiliação" link={{ href: "/portal/afiliacao", label: "Abrir" }} />
          <Card>
            <ul className="divide-y divide-border">
              <li>
                <ListRow
                  icon={HandCoins}
                  title="Comissão disponível"
                  value={formatCurrency(Number(affiliate.wallet.available))}
                  href="/portal/afiliacao"
                />
              </li>
              <li>
                <ListRow
                  icon={HandCoins}
                  title="Comissão em carência"
                  value={formatCurrency(Number(affiliate.wallet.pending))}
                  href="/portal/afiliacao"
                />
              </li>
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}
