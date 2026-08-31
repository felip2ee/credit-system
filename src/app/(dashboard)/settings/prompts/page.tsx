import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { PromptsForm } from "@/components/settings/prompts-form";
import { getAiPrompts } from "@/actions/settings";
import { getRequiredSession } from "@/lib/auth/session";

export default async function PromptsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (session.role !== "admin") redirect("/settings");
  const prompts = await getAiPrompts();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prompts da IA"
        description="System prompts dos analisadores de crédito (PF, PJ e Empresa)"
      />
      <PromptsForm prompts={prompts} />
    </div>
  );
}
