import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { LedgerTable } from "@/components/wallet/LedgerTable";
import { TopupDialog } from "@/components/wallet/TopupDialog";
import { WalletBalance } from "@/components/wallet/WalletBalance";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listPixCharges } from "@/lib/wallet/pix-charges";
import { getWallet, listLedger } from "@/lib/wallet/queries";

export const metadata = { title: "Carteira" };

export default async function WalletPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "wallet:read") || !session.bureauId) redirect("/");

  const { bureauId } = session;
  const data = await withUserTransaction(session, async (client) => ({
    wallet: await getWallet(client, bureauId),
    ledger: await listLedger(client, bureauId),
    charges: await listPixCharges(client, bureauId),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Carteira" description="Saldo, recargas por PIX e extrato do seu Bureau" />
      {data.wallet ? (
        <WalletBalance wallet={data.wallet}>
          {hasPermission(session, "wallet:topup") && (
            <TopupDialog charges={data.charges.map(({ id, status }) => ({ id, status }))} />
          )}
        </WalletBalance>
      ) : (
        <p className="text-sm text-muted-foreground">Carteira não encontrada.</p>
      )}
      <LedgerTable
        key={data.ledger.rows[0]?.id ?? "empty"}
        bureauId={bureauId} initialRows={data.ledger.rows} initialCursor={data.ledger.nextCursor} />
    </div>
  );
}
