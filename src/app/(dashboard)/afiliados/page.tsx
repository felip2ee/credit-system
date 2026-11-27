import { redirect } from "next/navigation";

import { AffiliateEnabledCard } from "@/components/affiliates/affiliate-enabled-card";
import { BureauAffiliatesTable } from "@/components/affiliates/bureau-affiliates-table";
import { PageHeader } from "@/components/layout/page-header";
import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import { getBureauDefaultPct, listBureauAffiliates } from "@/lib/affiliates/rates";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Afiliados" };

export default async function AffiliatesPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read") || !session.bureauId) redirect("/");

  const enabled = await isAffiliateEnabled(session);
  const affiliates = enabled ? await listBureauAffiliates(session) : [];
  const defaultPct = await getBureauDefaultPct(session);

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliados" description="Quem indica clientes ao seu Bureau e a comissão paga a eles" />
      {hasPermission(session, "affiliate_settings:manage") && <AffiliateEnabledCard enabled={enabled} />}
      {enabled && <BureauAffiliatesTable defaultPct={defaultPct} affiliates={affiliates} />}
    </div>
  );
}
