import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PayoutMethodCards } from "@/components/affiliates/PayoutMethodCards";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { getPayoutSettings } from "@/lib/affiliates/payout-settings";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Configurar pagamentos" };

export default async function AffiliatePayoutsPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliate_payout:manage")) redirect("/portal");

  const current = await getPayoutSettings(session, session.userId);

  return (
    <div className="space-y-6">
      <PageHeader title="Configurar pagamentos" />
      <Link href="/portal/afiliacao" className="inline-flex min-h-12 items-center gap-1 font-bold text-primary hover:underline">
        <ArrowLeft aria-hidden className="size-5" />
        Voltar para afiliação
      </Link>
      {current ? (
        <PayoutMethodCards current={current} />
      ) : (
        <StatusBanner tone="neutral" title="Seu código de afiliado ainda não está disponível." description="Tente de novo mais tarde." />
      )}
    </div>
  );
}
