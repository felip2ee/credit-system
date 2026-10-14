import { redirect } from "next/navigation";

import { DossierForm } from "@/components/dossiers/dossier-form";
import { PageHeader } from "@/components/layout/page-header";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export default async function NewDossierPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "consultations:write")) redirect("/dossiers");

  return (
    <div className="space-y-6">
      <PageHeader
        title="PJ completo"
        description="Informe o CNPJ e os CPFs dos sócios a consultar em conjunto"
      />
      <DossierForm />
    </div>
  );
}
