import { redirect } from "next/navigation";

import { HolderForm } from "@/components/holders/holder-form";
import { PageHeader } from "@/components/layout/page-header";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export default async function NewHolderPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "holders:write")) redirect("/holders");

  return (
    <div className="max-w-3xl">
      <PageHeader title="Novo titular" description="Cadastre uma pessoa física ou jurídica" />
      <HolderForm />
    </div>
  );
}
