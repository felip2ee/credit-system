import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ScrTermForm } from "@/components/settings/scr-term-form";
import { getScrTermSettings } from "@/actions/settings";
import { isAdmin } from "@/lib/auth";

export default async function ScrSettingsPage() {
  if (!(await isAdmin())) redirect("/settings");
  const settings = await getScrTermSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Termo SCR"
        description="Configuração do termo de consentimento da autogestão de SCR"
      />
      <ScrTermForm initial={settings} />
    </div>
  );
}
