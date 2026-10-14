import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { PayableLedgerTable } from "@/components/payouts/PayableLedgerTable";
import { PayableSummary } from "@/components/payouts/PayableSummary";
import { PayoutTable } from "@/components/payouts/PayoutTable";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listPayableEntries, getPayableBalance } from "@/lib/payables/queries";
import { listPayouts } from "@/lib/payouts/queries";

export const metadata = { title: "Repasses" };

export default async function PayoutsSettingsPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  // O operator não chega aqui; suporte não lê repasse (a RLS também barra).
  if (!hasPermission(session, "payout:read") || !session.bureauId || session.supportSessionId) redirect("/");

  const { bureauId } = session;
  const data = await withUserTransaction(session, async (client) => ({
    balance: await getPayableBalance(client, bureauId),
    payouts: await listPayouts(client, { bureauId }),
    entries: await listPayableEntries(client, bureauId),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Repasses" description="Valor a receber da plataforma, repasses e lançamentos do seu Bureau" />
      <PayableSummary balance={data.balance} />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Repasses</h2>
        <PayoutTable payouts={data.payouts} />
      </section>
      <PayableLedgerTable
        key={data.entries.rows[0]?.id ?? "empty"}
        bureauId={bureauId}
        initialRows={data.entries.rows}
        initialCursor={data.entries.nextCursor}
      />
    </div>
  );
}
