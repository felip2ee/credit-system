import { PageHeader } from "@/components/layout/page-header";
import { canManagePayouts } from "@/components/payouts/payout-logic";
import { NfseFailuresTable } from "@/components/superadmin/NfseFailuresTable";
import { getRequiredSession } from "@/lib/auth/session";
import { listBureauMetrics } from "@/lib/bureaus/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listNfseFailures } from "@/lib/nfse/queries";

export const metadata = { title: "NFS-e" };

export default async function SuperadminNfsePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session, "nfse:manage") || session.supportSessionId || session.support) {
    return (
      <div className="space-y-6">
        <PageHeader title="NFS-e" description="Notas fiscais com falha" />
        <p className="text-sm text-muted-foreground">Encerre a sessão de suporte para ver as notas fiscais.</p>
      </div>
    );
  }
  const canRetry = canManagePayouts({
    role: session.role,
    supportSessionId: session.supportSessionId,
    support: session.support,
    canManage: true,
  });

  const [failures, bureaus] = await Promise.all([
    withUserTransaction(session, (client) => listNfseFailures(client)),
    listBureauMetrics(session),
  ]);
  const names = new Map(bureaus.map((b) => [b.bureauId, b.name]));
  const rows = failures.map((f) => ({
    chargeId: f.chargeId,
    bureauName: names.get(f.bureauId) ?? "—",
    amount: f.amount,
    attempts: f.attempts,
    updatedAt: f.updatedAt,
    createdAt: f.createdAt,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="NFS-e" description="Notas fiscais com falha. A falha da nota não afeta o crédito do cliente." />
      <NfseFailuresTable rows={rows} canRetry={canRetry} />
    </div>
  );
}
