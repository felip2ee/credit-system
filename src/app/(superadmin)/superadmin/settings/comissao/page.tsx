import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CommissionForm } from "@/components/superadmin/commission-form";
import { getRequiredSession } from "@/lib/auth/session";
import { readBureauCommissionPct } from "@/lib/settings/readers";

export const metadata = { title: "Comissão dos Bureaus" };

export default async function BureauCommissionPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "superadmin") redirect("/");
  const pct = await readBureauCommissionPct(session);

  return (
    <div className="space-y-6">
      <PageHeader title="Comissão dos Bureaus" description="% do preço bruto que o Bureau recebe, válida para todos os Bureaus" />
      <CommissionForm initialPct={pct} />
    </div>
  );
}
