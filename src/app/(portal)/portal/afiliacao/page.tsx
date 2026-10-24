import Link from "next/link";
import { redirect } from "next/navigation";

import { AffiliateLinkCard } from "@/components/affiliates/affiliate-link-card";
import { CommissionTables } from "@/components/affiliates/commission-table";
import { ConvertForm } from "@/components/affiliates/convert-form";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { affiliateLink } from "@/lib/affiliates/rates";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { readWithdrawalFee } from "@/lib/affiliates/withdrawals";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { readAffiliateWithdrawalsEnabled } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Afiliação" };

export default async function AffiliatePage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read")) redirect("/portal");

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
  const { code, wallet, referrals, commissions } = data.summary;
  const hasAvailable = Number(wallet.available) > 0;
  const withdrawalsEnabled = readAffiliateWithdrawalsEnabled(process.env);
  const fee = withdrawalsEnabled ? await readWithdrawalFee(session) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliação" />
      <AffiliateLinkCard link={affiliateLink(data.slug, code)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-normal text-muted-foreground">Comissão disponível</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold">{formatCurrency(Number(wallet.available))}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-normal text-muted-foreground">Em carência</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold">{formatCurrency(Number(wallet.pending))}</CardContent>
        </Card>
      </div>
      {hasAvailable && (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Usar a comissão</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ConvertForm available={wallet.available} />
            {fee ? (
              <>
                <p className="text-muted-foreground">
                  Taxa de saque: {formatCurrency(Number(fee.fixed))} + {fee.percent}%
                </p>
                <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
                  <Link href="/portal/afiliacao/saque">Sacar por PIX</Link>
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground">Saque disponível em breve.</p>
            )}
          </CardContent>
        </Card>
      )}
      <CommissionTables referrals={referrals} commissions={commissions} />
    </div>
  );
}
