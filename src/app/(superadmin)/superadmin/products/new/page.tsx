import { notFound } from "next/navigation";

import { ProductForm } from "@/components/superadmin/product-form";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Novo produto" };

export default async function NewProductPage() {
  const session = await getRequiredSession();
  if (session.role !== "superadmin" || !hasPermission(session, "catalog:write")) notFound();

  // O título e a saída ficam no cabeçalho do assistente (ScreenHeader): sem PageHeader, para não duplicar o h1.
  return <ProductForm />;
}
