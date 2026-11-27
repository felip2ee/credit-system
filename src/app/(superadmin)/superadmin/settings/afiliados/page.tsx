import { redirect } from "next/navigation";

import { AffiliateSettingsForm } from "@/components/affiliates/affiliate-settings-form";
import { getRequiredSession } from "@/lib/auth/session";
import { readAffiliateSettings } from "@/lib/settings/readers";

import { SettingsHeader } from "../settings-header";

export const metadata = { title: "Afiliados" };

export default async function AffiliateSettingsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "superadmin") redirect("/");
  const settings = await readAffiliateSettings(session);

  return (
    <div className="space-y-4">
      <SettingsHeader title="Afiliados" description="Carência da comissão e taxa de saque, válidas para todos os Bureaus" />
      <AffiliateSettingsForm initial={settings} />
    </div>
  );
}
