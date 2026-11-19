import { redirect } from "next/navigation";

import { DossierForm, type CatalogOption } from "@/components/dossiers/dossier-form";
import { PageHeader } from "@/components/layout/page-header";
import { getRequiredSession } from "@/lib/auth/session";
import { listCatalog } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export default async function NewDossierPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "consultations:write")) redirect("/dossiers");

  // O catálogo já só traz o que está à venda; o preço vem da plataforma, nunca do operador.
  const onSale = await listCatalog(session);
  const toOption = (e: (typeof onSale)[number]): CatalogOption => ({
    code: e.code,
    name: e.name,
    price: e.salePrice,
    pricePerPartner: e.salePricePerPartner,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Novo pedido de balcão"
        description="Escolha o produto e informe o titular. A consulta roda depois do pagamento e da autorização do titular"
      />
      <DossierForm products={onSale.map(toOption)} />
    </div>
  );
}
