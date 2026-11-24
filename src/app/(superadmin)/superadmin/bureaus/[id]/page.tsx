import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/layout/page-header";
import { BureauEditForm } from "@/components/superadmin/bureau-edit-form";
import { AdminCredentialsForm } from "@/components/superadmin/admin-credentials-form";
import { InviteAdminForm } from "@/components/superadmin/invite-admin-form";
import { SupportStartForm } from "@/components/superadmin/support-start-form";
import { BureauCommissionPanel } from "@/components/superadmin/bureau-commission-panel";
import { BureauProductBlocksPanel } from "@/components/superadmin/bureau-product-blocks-panel";
import { getBureauDefaultPct } from "@/lib/affiliates/rates";
import { getEffectiveCommission } from "@/lib/catalog/queries";
import { listBureauCommissionRates, listBureauProductBlocks } from "@/lib/commission/queries";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { CopyLinkButton } from "@/components/superadmin/copy-link-button";
import { config } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listRefundShortfalls } from "@/lib/wallet/pix-charges";
import { getWallet, listLedger } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";
import { LedgerTable } from "@/components/wallet/LedgerTable";
import { WalletBalance } from "@/components/wallet/WalletBalance";
import { WalletAdjustForm } from "@/components/superadmin/WalletAdjustForm";
import { StatusBanner } from "@/components/ui/status-banner";

export const metadata = { title: "Bureau" };

export default async function BureauDetailPage({ params }: { params: { id: string } }) {
  if (!z.string().uuid().safeParse(params.id).success) notFound();
  const session = await getRequiredSession();
  const bureau = await getBureau(session, params.id);
  if (!bureau) notFound();
  const canManage = hasPermission(session, "bureaus:manage") && !session.supportSessionId;
  const commission = hasPermission(session, "catalog:read")
    ? {
        effective: await getEffectiveCommission(session, bureau.id),
        history: await listBureauCommissionRates(session, bureau.id),
        affiliatePct: await getBureauDefaultPct(session, bureau.id),
        blocks: await listBureauProductBlocks(session, bureau.id),
      }
    : null;

  const wallet = hasPermission(session, "wallet:read")
    ? await withUserTransaction(session, async (client) => ({
        balance: await getWallet(client, bureau.id),
        ledger: await listLedger(client, bureau.id),
        shortfalls: await listRefundShortfalls(client, bureau.id),
      }))
    : null;
  // Sem ajuste em sessão de suporte (a action também recusa).
  const canAdjust = hasPermission(session, "wallet:adjust") && !session.supportSessionId;

  const publicUrl = `${config.betterAuthUrl.replace(/\/$/, "")}/b/${bureau.slug}`;

  return (
    <div className="space-y-6">
      <PageHeader title={bureau.name}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Endereço público:</span>
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="break-all font-medium underline">
            {publicUrl}
          </a>
          <CopyLinkButton url={publicUrl} />
        </div>
      </PageHeader>
      <BureauEditForm bureau={bureau} />
      <InviteAdminForm bureauId={bureau.id} />
      <AdminCredentialsForm bureauId={bureau.id} />
      <SupportStartForm bureauId={bureau.id} />
      {commission && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Comissão</h2>
            <p className="text-sm text-muted-foreground">
              O Bureau recebe uma % do preço bruto de cada venda. Sem override, vale a % global.
            </p>
            <BureauCommissionPanel
              bureauId={bureau.id}
              effective={commission.effective}
              history={commission.history}
              affiliatePct={commission.affiliatePct}
              canWrite={canManage && hasPermission(session, "affiliates:manage")}
            />
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Produtos bloqueados</h2>
            <BureauProductBlocksPanel bureauId={bureau.id} rows={commission.blocks} canWrite={canManage} />
          </section>
        </>
      )}
      {wallet?.balance && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Carteira</h2>
          {wallet.shortfalls.length > 0 && (
            <StatusBanner
              tone="attention"
              title="Estorno com saldo insuficiente"
              description={
                <div className="space-y-1">
                  {wallet.shortfalls.map((s) => (
                    <p key={s.chargeId}>
                      {formatCurrency(Number(s.shortfall))} a recuperar (recarga de {formatCurrency(Number(s.amount))} em{" "}
                      {s.createdAt.toLocaleDateString("pt-BR")}).
                    </p>
                  ))}
                  <p>Recupere o valor com um ajuste manual.</p>
                </div>
              }
            />
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
