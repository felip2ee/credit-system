import { PayableLedgerTable } from "@/components/payouts/PayableLedgerTable";
import { PayoutTable } from "@/components/payouts/PayoutTable";
import type { RequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { listPayableEntries } from "@/lib/payables/queries";
import { listPayouts } from "@/lib/payouts/queries";

// Repasses e lançamentos do Bureau. O chamador já checou `payout:read`.
export async function PayablesPanel({ session, bureauId }: { session: RequiredSession; bureauId: string }) {
  const data = await withUserTransaction(session, async (client) => ({
    payouts: await listPayouts(client, { bureauId }),
    entries: await listPayableEntries(client, bureauId),
  }));
  return (
    <div className="space-y-6">
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
