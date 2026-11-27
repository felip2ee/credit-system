import { redirect } from "next/navigation";

import { PayableRetentionForm } from "@/components/settings/payable-retention-form";
import { getRequiredSession } from "@/lib/auth/session";
import { readPayableRetentionDays } from "@/lib/settings/readers";

import { SettingsHeader } from "../settings-header";

export const metadata = { title: "Prazo dos repasses" };

export default async function PayableRetentionPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "superadmin") redirect("/");
  const days = await readPayableRetentionDays(session);

  return (
    <div className="space-y-4">
      <SettingsHeader title="Prazo dos repasses" description="Retenção do valor a receber, válida para todos os Bureaus" />
      <PayableRetentionForm initialDays={days} />
    </div>
  );
}
