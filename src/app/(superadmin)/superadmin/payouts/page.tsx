import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CreatePayoutForm } from "@/components/payouts/CreatePayoutForm";
import { canManagePayouts } from "@/components/payouts/payout-logic";
import { PayoutTable } from "@/components/payouts/PayoutTable";
import { getRequiredSession } from "@/lib/auth/session";
import { listBureauMetrics } from "@/lib/bureaus/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getPayableBalances, getPayableRetentionDays } from "@/lib/payables/queries";
import { latestPayoutDate } from "@/lib/payouts/cutoff";
import { listPayouts } from "@/lib/payouts/queries";

export const metadata = { title: "Repasses" };

export default async function SuperadminPayoutsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  const inSupport = Boolean(session.supportSessionId || session.support);
  if (!hasPermission(session, "payout:read") || inSupport) {
    return (
      <div className="space-y-6">
        <PageHeader title="Repasses" description="Repasses aos Bureaus" />
        <p className="text-sm text-muted-foreground">Encerre a sessão de suporte para ver os repasses.</p>
      </div>
    );
  }
  const canManage = canManagePayouts({
    role: session.role,
    supportSessionId: session.supportSessionId,
    support: session.support,
    canManage: hasPermission(session, "payout:manage"),
  });

  const bureaus = await listBureauMetrics(session);
  const data = await withUserTransaction(session, async (client) => ({
    payouts: await listPayouts(client),
    payable: await getPayableBalances(client),
  }));
  const latestDate = latestPayoutDate(await getPayableRetentionDays(session));
  const bureauNames = Object.fromEntries(bureaus.map((b) => [b.bureauId, b.name]));

  return (
    <div className="space-y-6">
      <PageHeader title="Repasses" description="Repasses aos Bureaus: criar, pagar com comprovante e cancelar" />
      {canManage && (
        <CreatePayoutForm latestDate={latestDate} bureaus={bureaus.map((b) => ({ id: b.bureauId, name: b.name, payable: data.payable.get(b.bureauId) ?? "0.00" }))} />
      )}
      <section className="space-y-3">
        <h2 className="font-semibold">Repasses</h2>
        <PayoutTable payouts={data.payouts} bureauNames={bureauNames} canManage={canManage} stacked />
      </section>
    </div>
  );
}
