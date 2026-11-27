import { redirect } from "next/navigation";

import { CommissionForm } from "@/components/superadmin/commission-form";
import { getRequiredSession } from "@/lib/auth/session";
import { readBureauCommissionPct } from "@/lib/settings/readers";

import { SettingsHeader } from "../settings-header";

export const metadata = { title: "Comissão dos Bureaus" };

export default async function BureauCommissionPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "superadmin") redirect("/");
  const pct = await readBureauCommissionPct(session);

  return (
    <div className="space-y-4">
      <SettingsHeader title="Comissão dos Bureaus" description="% do preço bruto que o Bureau recebe. Vale para todo Bureau que não tem uma % própria" />
      <CommissionForm initialPct={pct} />
    </div>
  );
}
