import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/layout/page-header";
import { BureauEditForm } from "@/components/superadmin/bureau-edit-form";
import { AdminCredentialsForm } from "@/components/superadmin/admin-credentials-form";
import { InviteAdminForm } from "@/components/superadmin/invite-admin-form";
import { SupportStartForm } from "@/components/superadmin/support-start-form";
import { BureauCostsPanel } from "@/components/superadmin/bureau-costs-panel";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { listBureauCosts } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listRefundShortfalls } from "@/lib/wallet/pix-charges";
import { getWallet, listLedger } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";
import { LedgerTable } from "@/components/wallet/LedgerTable";
import { WalletBalance } from "@/components/wallet/WalletBalance";
import { WalletAdjustForm } from "@/components/superadmin/WalletAdjustForm";

export const metadata = { title: "Bureau" };

export default async function BureauDetailPage({ params }: { params: { id: string } }) {
  if (!z.string().uuid().safeParse(params.id).success) notFound();
  const session = await getRequiredSession();
  const bureau = await getBureau(session, params.id);
  if (!bureau) notFound();
  const costs = hasPermission(session, "catalog:read") ? await listBureauCosts(session, bureau.id) : null;

  const wallet = hasPermission(session, "wallet:read")
    ? await withUserTransaction(session, async (client) => ({
        balance: await getWallet(client, bureau.id),
        ledger: await listLedger(client, bureau.id),
        shortfalls: await listRefundShortfalls(client, bureau.id),
      }))
    : null;
  // Sem ajuste em sessão de suporte (a action também recusa).
  const canAdjust = hasPermission(session, "wallet:adjust") && !session.supportSessionId;

  return (
    <div className="space-y-6">
      <PageHeader title={bureau.name} description={`Endereço público: /b/${bureau.slug}`} />
      <BureauEditForm bureau={bureau} />
      <InviteAdminForm bureauId={bureau.id} />
      <AdminCredentialsForm bureauId={bureau.id} />
      <SupportStartForm bureauId={bureau.id} />
      {costs && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Custos</h2>
          <p className="text-sm text-muted-foreground">
            Custo que o Bureau paga por produto. Sem override, vale o custo padrão.
          </p>
          <BureauCostsPanel bureauId={bureau.id} rows={costs} />
        </section>
      )}
      {wallet?.balance && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Carteira</h2>
          {wallet.shortfalls.length > 0 && (
            <div role="alert" className="space-y-1 rounded-md border border-destructive p-3 text-sm">
              {wallet.shortfalls.map((s) => (
                <p key={s.chargeId}>
                  Estorno com saldo insuficiente: {formatCurrency(Number(s.shortfall))} a recuperar (recarga de{" "}
                  {formatCurrency(Number(s.amount))} em {s.createdAt.toLocaleDateString("pt-BR")}).
                </p>
              ))}
              <p>Recupere o valor com um ajuste manual.</p>
            </div>
          )}
          <WalletBalance wallet={wallet.balance} />
          {canAdjust && <WalletAdjustForm bureauId={bureau.id} />}
          <LedgerTable
            key={wallet.ledger.rows[0]?.id ?? "empty"}
            bureauId={bureau.id} initialRows={wallet.ledger.rows} initialCursor={wallet.ledger.nextCursor} />
        </section>
      )}
    </div>
  );
}
