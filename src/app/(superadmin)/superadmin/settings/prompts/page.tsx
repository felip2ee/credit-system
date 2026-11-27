import { PromptsForm } from "@/components/settings/prompts-form";
import { getAiPrompts } from "@/actions/settings";

import { SettingsHeader } from "../settings-header";

export const metadata = { title: "Prompts da IA" };

export default async function PromptsPage() {
  const prompts = await getAiPrompts();

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Prompts da IA"
        description="System prompts dos analisadores de crédito (PF, PJ e Empresa), válidos para todos os Bureaus"
      />
      <PromptsForm prompts={prompts} />
    </div>
  );
}
