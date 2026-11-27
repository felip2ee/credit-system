import { notFound, redirect } from "next/navigation";

import { PayoutMethodCards } from "@/components/affiliates/PayoutMethodCards";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import { getPayoutSettings } from "@/lib/affiliates/payout-settings";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Configurar pagamentos" };

export default async function AffiliatePayoutsPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliate_payout:manage")) redirect("/portal");
  // Seção desligada pelo Bureau (padrão): a rota não existe para o cliente.
  if (!(await isAffiliateEnabled(session))) notFound();

  const current = await getPayoutSettings(session, session.userId);

  return (
    <div className="space-y-6">
      <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title="Configurar pagamentos" backHref="/portal/afiliacao" backLabel="Voltar para afiliação" />
      {current ? (
        <PayoutMethodCards current={current} />
      ) : (
        <StatusBanner tone="neutral" title="Seu código de afiliado ainda não está disponível." description="Tente de novo mais tarde." />
      )}
    </div>
  );
}
