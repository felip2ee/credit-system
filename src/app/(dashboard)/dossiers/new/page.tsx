import { redirect } from "next/navigation";

import { DossierForm, type CatalogOption } from "@/components/dossiers/dossier-form";
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

  // O título e a saída ficam no cabeçalho do assistente (ScreenHeader): sem PageHeader, para não duplicar o h1.
  return <DossierForm products={onSale.map(toOption)} />;
}
