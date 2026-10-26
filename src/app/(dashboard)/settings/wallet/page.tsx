import { redirect } from "next/navigation";

import { CounterPaymentsOverview } from "@/components/counter-payments/CounterPaymentsOverview";
import { PageHeader } from "@/components/layout/page-header";
import { PayablesPanel } from "@/components/payouts/PayablesPanel";
import { Card } from "@/components/ui/card";
import { LedgerTable } from "@/components/wallet/LedgerTable";
import { TopupDialog } from "@/components/wallet/TopupDialog";
import { WalletBalance } from "@/components/wallet/WalletBalance";
import { WalletTabs } from "@/components/wallet/WalletTabs";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getPayableBalance } from "@/lib/payables/queries";
import { formatCurrency } from "@/lib/utils";
import { parseWalletTab, visibleWalletTabs } from "@/lib/wallet/tabs";
import { listPixCharges } from "@/lib/wallet/pix-charges";
import { getWallet, listLedger } from "@/lib/wallet/queries";

export const metadata = { title: "Carteira" };

export default async function WalletPage({ searchParams }: { searchParams: { aba?: string | string[]; filter?: string; q?: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "wallet:read") || !session.bureauId) redirect("/");

  const { bureauId } = session;
  // Suporte não lê repasse (a RLS também barra).
  const canPayout = hasPermission(session, "payout:read") && !session.supportSessionId;
  const tabs = visibleWalletTabs({ payout: canPayout, counter: hasPermission(session, "counter:read") });
  const tab = parseWalletTab(searchParams.aba, tabs);
  const data = await withUserTransaction(session, async (client) => ({
    wallet: await getWallet(client, bureauId),
    ledger: tab === "extrato" ? await listLedger(client, bureauId) : null,
    charges: await listPixCharges(client, bureauId),
    payable: canPayout ? await getPayableBalance(client, bureauId) : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Carteira" description="Saldo, valores a receber e pagamentos do seu Bureau" />
      <div className="grid gap-3 sm:grid-cols-2">
        {data.wallet ? (
          <WalletBalance wallet={data.wallet}>
            {hasPermission(session, "wallet:topup") && (
              <TopupDialog charges={data.charges.map(({ id, status }) => ({ id, status }))} />
            )}
          </WalletBalance>
        ) : (
          <p className="text-sm text-muted-foreground">Carteira não encontrada.</p>
        )}
        {data.payable !== null && (
          <Card className="space-y-1 self-start p-5">
            <h2 className="text-base">A receber</h2>
            <p className="text-4xl font-bold leading-tight tabular-nums">{formatCurrency(Number(data.payable))}</p>
            <p className="text-base text-muted-foreground">Lucro dos pedidos online. Repassado pela Rainha Cred.</p>
          </Card>
        )}
      </div>
      <WalletTabs tabs={tabs} active={tab} />
      {tab === "extrato" && data.ledger && (
        <LedgerTable
          key={data.ledger.rows[0]?.id ?? "empty"}
          bureauId={bureauId} initialRows={data.ledger.rows} initialCursor={data.ledger.nextCursor} />
      )}
      {tab === "a-receber" && <PayablesPanel session={session} bureauId={bureauId} />}
      {tab === "balcao" && (
        <CounterPaymentsOverview
          session={session}
          filterParam={searchParams.filter}
          qParam={searchParams.q}
          basePath="/settings/wallet"
          baseParams={{ aba: "balcao" }}
        />
      )}
    </div>
  );
}
