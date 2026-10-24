import Link from "next/link";
import { redirect } from "next/navigation";

import { AffiliateLinkCard } from "@/components/affiliates/affiliate-link-card";
import { CommissionTables } from "@/components/affiliates/commission-table";
import { ConvertForm } from "@/components/affiliates/convert-form";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { affiliateLink } from "@/lib/affiliates/rates";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
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
        <p className="text-sm text-muted-foreground">Seu código de afiliado ainda não está disponível.</p>
      </div>
    );
  }
  const { code, wallet, referrals, commissions } = data.summary;
  const hasAvailable = Number(wallet.available) > 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliação" />
      <AffiliateLinkCard link={affiliateLink(data.slug, code)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Comissão disponível</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{formatCurrency(Number(wallet.available))}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Em carência</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{formatCurrency(Number(wallet.pending))}</CardContent>
        </Card>
      </div>
      {hasAvailable && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Usar a comissão</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ConvertForm available={wallet.available} />
            <Button asChild variant="outline">
              <Link href="/portal/afiliacao/saque">Sacar por PIX</Link>
            </Button>
          </CardContent>
        </Card>
      )}
      <CommissionTables referrals={referrals} commissions={commissions} />
    </div>
  );
}
