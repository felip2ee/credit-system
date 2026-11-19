import { redirect } from "next/navigation";

import { BureauAffiliatesTable } from "@/components/affiliates/bureau-affiliates-table";
import { PageHeader } from "@/components/layout/page-header";
import { getBureauDefaultPct, listBureauAffiliates } from "@/lib/affiliates/rates";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Afiliados" };

export default async function AffiliatesPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read") || !session.bureauId) redirect("/");

  const affiliates = await listBureauAffiliates(session);
  const defaultPct = await getBureauDefaultPct(session);

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliados" description="Quem indica clientes ao seu Bureau e a comissão paga a eles" />
      <BureauAffiliatesTable defaultPct={defaultPct} affiliates={affiliates} />
    </div>
  );
}
