import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CommissionForm } from "@/components/settings/commission-form";
import { getCommissionRate } from "@/actions/settings";
import { getRequiredSession } from "@/lib/auth/session";

export default async function CommissionSettingsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "admin") redirect("/settings");
  const rate = await getCommissionRate();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Comissão"
        description="Comissão bruta padrão estimada usada nos relatórios do Dashboard"
      />
      <CommissionForm initialRate={rate} />
    </div>
  );
}
