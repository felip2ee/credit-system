import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CatalogForm } from "@/components/settings/catalog-form";
import { getRequiredSession } from "@/lib/auth/session";
import { listCatalog } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export default async function CatalogPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "catalog:read")) redirect("/");

  const entries = await listCatalog(session);

  return (
    <div>
      <PageHeader
        title="Catálogo"
        description="Produtos à venda, preços e custos do seu Bureau"
      />
      <CatalogForm entries={entries} canWrite={hasPermission(session, "catalog:write")} />
    </div>
  );
}
