import { redirect } from "next/navigation";

import { DossierForm, type CatalogOption } from "@/components/dossiers/dossier-form";
import { PageHeader } from "@/components/layout/page-header";
import { getRequiredSession } from "@/lib/auth/session";
import { listCatalog } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export default async function NewDossierPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "consultations:write")) redirect("/dossiers");

  // Só itens à venda; o preço vem do catálogo, nunca do operador.
  const onSale = (await listCatalog(session)).filter((e) => e.onSale && e.item);
  const toOption = (e: (typeof onSale)[number]): CatalogOption => ({
    code: e.code,
    name: e.name,
    price: e.item?.salePrice ?? "0.00",
    addonFor: e.addonFor,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Novo pedido de balcão"
        description="Escolha o produto e informe o titular. A consulta roda depois do pagamento e da autorização do titular"
      />
      <DossierForm
        products={onSale.filter((e) => e.kind === "main").map(toOption)}
        addons={onSale.filter((e) => e.kind === "addon").map(toOption)}
      />
    </div>
  );
}
