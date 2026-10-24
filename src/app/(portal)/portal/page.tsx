import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { ClientOrderList } from "@/components/orders/client-order-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { listMyOrders } from "@/lib/orders/client-queries";
import { formatCurrency } from "@/lib/utils";
import { getClientWallet } from "@/lib/wallet/client-queries";

const RECENT_ORDERS = 5;

export default async function PortalHomePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session, "portal:read")) return null;
  const profile = await getCurrentProfile();
  const firstName = profile?.full_name.split(" ")[0] ?? "";
  const showCredits = hasPermission(session, "credits:read");
  const showAffiliate = hasPermission(session, "affiliates:read");
  const { orders, wallet, affiliate } = await withUserTransaction(session, async (client) => ({
    orders: await listMyOrders(client, RECENT_ORDERS),
    wallet: showCredits ? await getClientWallet(client, session.userId) : null,
    affiliate: showAffiliate ? await getMyAffiliateSummary(client) : null,
  }));
  const balances = [
    ...(showCredits ? [{ label: "Créditos disponíveis", value: wallet?.available ?? "0", href: "/portal/credits" }] : []),
    ...(affiliate
      ? [
          { label: "Comissão disponível", value: affiliate.wallet.available, href: "/portal/afiliacao" },
          { label: "Comissão em carência", value: affiliate.wallet.pending, href: "/portal/afiliacao" },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Olá{firstName ? `, ${firstName}` : ""}</h1>
      </div>
      {balances.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          {balances.map((b) => (
            <Link key={b.label} href={b.href}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-sm font-medium text-muted-foreground">{b.label}</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{formatCurrency(Number(b.value))}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Suas pesquisas</CardTitle>
          {orders.length > 0 && (
            <Link href="/portal/pesquisas" className="text-sm underline">
              Ver todas
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {orders.length > 0 ? (
            <ClientOrderList orders={orders} />
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Assim que uma pesquisa for liberada para você, ela aparecerá aqui.</p>
              <Button asChild>
                <Link href="/portal/pesquisas/nova">Nova pesquisa</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
