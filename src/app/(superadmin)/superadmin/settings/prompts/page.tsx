import { PageHeader } from "@/components/layout/page-header";
import { PromptsForm } from "@/components/settings/prompts-form";
import { getAiPrompts } from "@/actions/settings";

export const metadata = { title: "Prompts da IA" };

export default async function PromptsPage() {
  const prompts = await getAiPrompts();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prompts da IA"
        description="System prompts dos analisadores de crédito (PF, PJ e Empresa), válidos para todos os Bureaus"
      />
      <PromptsForm prompts={prompts} />
    </div>
  );
}
