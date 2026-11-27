import { redirect } from "next/navigation";

import { NewConsultationFlow } from "@/components/admin/new-consultation-flow";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { listCatalog } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export default async function AdminNewConsultationPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!session.bureauId || !hasPermission(session, "consultations:write")) redirect("/admin");

  const [bureau, onSale] = await Promise.all([getBureau(session, session.bureauId), listCatalog(session)]);
  // O catálogo já só traz o que está à venda; o preço vem da plataforma, nunca do operador.
  const products = onSale.flatMap((e) => (e.salePrice === null ? [] : [{ code: e.code, name: e.name, price: e.salePrice }]));

  // O título e a saída ficam no cabeçalho do assistente (ScreenHeader): sem PageHeader, para não duplicar o h1.
  return <NewConsultationFlow bureauName={bureau?.name ?? "Bureau"} products={products} />;
}
