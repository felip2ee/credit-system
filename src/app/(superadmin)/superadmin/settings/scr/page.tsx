import { PageHeader } from "@/components/layout/page-header";
import { ScrTermForm } from "@/components/settings/scr-term-form";
import { getScrTermSettings } from "@/actions/settings";

export const metadata = { title: "Termo SCR" };

export default async function ScrSettingsPage() {
  const settings = await getScrTermSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Termo SCR"
        description="Termo de consentimento da autogestão de SCR, válido para todos os Bureaus"
      />
      <ScrTermForm initial={settings} />
    </div>
  );
}
