import { ScrTermForm } from "@/components/settings/scr-term-form";
import { getScrTermSettings } from "@/actions/settings";

import { SettingsHeader } from "../settings-header";

export const metadata = { title: "Termo SCR" };

export default async function ScrSettingsPage() {
  const settings = await getScrTermSettings();

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Termo SCR"
        description="Termo de consentimento da autogestão de SCR, válido para todos os Bureaus"
      />
      <ScrTermForm initial={settings} />
    </div>
  );
}
