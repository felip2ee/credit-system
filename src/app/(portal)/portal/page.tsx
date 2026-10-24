import Link from "next/link";
import { FolderOpen, HandCoins } from "lucide-react";

import { ClientOrderList } from "@/components/orders/client-order-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
        <h1 className="text-2xl font-bold">Olá{firstName ? `, ${firstName}` : ""}</h1>
      </div>
      <Button asChild size="lg" className="w-full sm:w-auto">
        <Link href="/portal/pesquisas/nova">Nova pesquisa</Link>
      </Button>
      {balances.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          {balances.map((b) => (
            <Link key={b.label} href={b.href} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full transition-colors hover:bg-muted/50 focus-within:ring-2">
                <CardHeader>
                  <CardTitle className="text-base font-normal text-muted-foreground">{b.label}</CardTitle>
                </CardHeader>
                <CardContent className="text-3xl font-bold">{formatCurrency(Number(b.value))}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {affiliate && (
        <Button asChild variant="outline" size="lg" className="w-full justify-start">
          <Link href="/portal/afiliacao">
            <HandCoins aria-hidden />
            Afiliação: seu link e suas comissões
          </Link>
        </Button>
      )}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-xl">Suas pesquisas</CardTitle>
          {orders.length > 0 && (
            <Link href="/portal/pesquisas" className="inline-flex min-h-12 items-center underline">
              Ver todas
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {orders.length > 0 ? (
            <ClientOrderList orders={orders} />
          ) : (
            <EmptyState
              icon={FolderOpen}
              title="Você ainda não fez nenhuma pesquisa"
              description="Quando você fizer uma pesquisa, ela aparece aqui."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
