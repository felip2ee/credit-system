import { redirect } from "next/navigation";

import { BureauAffiliatesTable } from "@/components/affiliates/bureau-affiliates-table";
import { PageHeader } from "@/components/layout/page-header";
import { listBureauAffiliates } from "@/lib/affiliates/rates";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

export const metadata = { title: "Afiliados" };

export default async function AffiliatesPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:manage") || !session.bureauId) redirect("/");

  const affiliates = await listBureauAffiliates(session);
  // Sem linha em bureau_affiliate_settings, o padrão do Bureau é 0 (default da coluna).
  const defaultPct = await withUserTransaction(session, async (client) => {
    const { rows } = await client.query<{ default_pct: string }>(
      "select default_pct from bureau_affiliate_settings where bureau_id = app_bureau_id()",
    );
    return rows[0]?.default_pct ?? "0.00";
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Afiliados" description="Quem indica clientes ao seu Bureau e a comissão de cada um" />
      <BureauAffiliatesTable defaultPct={defaultPct} affiliates={affiliates} />
    </div>
  );
}
