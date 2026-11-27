import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AffiliateBalance } from "@/components/affiliates/affiliate-balance";
import { AffiliateLinkCard } from "@/components/affiliates/affiliate-link-card";
import { HowItWorks } from "@/components/affiliates/how-it-works";
import { CommissionTables } from "@/components/affiliates/commission-table";
import { UseCommissionCard } from "@/components/affiliates/use-commission-card";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import { affiliateLink } from "@/lib/affiliates/rates";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { getPayoutSettings } from "@/lib/affiliates/payout-settings";
import { readWithdrawalFee } from "@/lib/affiliates/withdrawals";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { readAffiliateWithdrawalsEnabled } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

export const metadata = { title: "Afiliação" };

export default async function AffiliatePage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read")) redirect("/portal");
  // Seção desligada pelo Bureau (padrão): a rota não existe para o cliente.
  if (!(await isAffiliateEnabled(session))) notFound();

  const data = await withUserTransaction(session, async (client) => {
    const summary = await getMyAffiliateSummary(client);
    const bureau = await client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()");
    return { summary, slug: bureau.rows[0]?.slug ?? null };
  });
  if (!data.summary || !data.slug) {
    return (
      <div className="space-y-6">
        <PageHeader title="Afiliação" />
        <StatusBanner tone="neutral" title="Seu código de afiliado ainda não está disponível." description="Tente de novo mais tarde." />
      </div>
    );
  }
  const { code, wallet, asaasReceived, referrals, commissions } = data.summary;
  const withdrawalsEnabled = readAffiliateWithdrawalsEnabled(process.env);
  const method = (await getPayoutSettings(session, session.userId))?.method ?? "pix";
  const fee = withdrawalsEnabled ? await readWithdrawalFee(session) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliação" />
      <HowItWorks fee={fee} method={method} />
      <AffiliateLinkCard link={affiliateLink(data.slug, code)} />
      <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
        <Link href="/portal/afiliacao/pagamentos">Configurar pagamentos</Link>
      </Button>
      <AffiliateBalance method={method} wallet={wallet} asaasReceived={asaasReceived} />
      <UseCommissionCard method={method} available={wallet.available} fee={fee} />
      <CommissionTables referrals={referrals} commissions={commissions} />
    </div>
  );
}
