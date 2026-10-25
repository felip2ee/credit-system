import Link from "next/link";
import { FilePlus2, FolderOpen, HandCoins, Wallet } from "lucide-react";

import { ClientOrderList } from "@/components/orders/client-order-list";
import { BalanceCard } from "@/components/ui/balance-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { QuickAction, QuickActions } from "@/components/ui/quick-actions";
import { SectionHeader } from "@/components/ui/section-header";
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
  const canTopup = hasPermission(session, "credits:topup");
  const { orders, wallet, affiliate } = await withUserTransaction(session, async (client) => ({
    orders: await listMyOrders(client, RECENT_ORDERS),
    wallet: showCredits ? await getClientWallet(client, session.userId) : null,
    affiliate: showAffiliate ? await getMyAffiliateSummary(client) : null,
  }));
  return (
    <div className="space-y-6">
      <section aria-labelledby="inicio-titulo" className="space-y-6 rounded-hero bg-background p-4 sm:p-6">
        <h1 id="inicio-titulo" className="text-2xl font-bold">
          Olá{firstName ? `, ${firstName}` : ""}
        </h1>
        {showCredits && wallet && (
          <BalanceCard
            label="Créditos disponíveis"
            value={formatCurrency(Number(wallet.available))}
            hideable
            hint={Number(wallet.reserved) > 0 ? `Reservado em pedidos: ${formatCurrency(Number(wallet.reserved))}` : undefined}
            action={
              <Button asChild variant="onBrand" size="lg">
                <Link href="/portal/credits">{canTopup ? "Recarregar" : "Ver extrato"}</Link>
              </Button>
            }
          />
        )}
        <div className="space-y-3">
          <h2 className="text-lg font-bold">Pro dia a dia</h2>
          <QuickActions>
            <QuickAction icon={FilePlus2} label="Nova pesquisa" href="/portal/pesquisas/nova" active />
            <QuickAction icon={FolderOpen} label="Pesquisas" href="/portal/pesquisas" />
            {showCredits && <QuickAction icon={Wallet} label="Créditos" href="/portal/credits" />}
            {affiliate && <QuickAction icon={HandCoins} label="Afiliação" href="/portal/afiliacao" />}
          </QuickActions>
        </div>
      </section>
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
      <section className="space-y-3">
        <SectionHeader title="Suas pesquisas" link={orders.length > 0 ? { href: "/portal/pesquisas", label: "Ver todas" } : undefined} />
        {orders.length > 0 ? (
          <ClientOrderList orders={orders} />
        ) : (
          <Card>
            <EmptyState
              icon={FolderOpen}
              title="Você ainda não fez nenhuma pesquisa"
              description="Quando você fizer uma pesquisa, ela aparece aqui."
            />
          </Card>
        )}
      </section>
    </div>
  );
}
