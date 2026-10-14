import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ProductForm } from "@/components/superadmin/product-form";
import { getRequiredSession } from "@/lib/auth/session";
import { listProducts } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Novo produto" };

export default async function NewProductPage() {
  const session = await getRequiredSession();
  if (session.role !== "superadmin" || !hasPermission(session, "catalog:write")) notFound();
  const products = await listProducts(session);
  const mainProducts = products
    .filter((p) => p.kind === "main")
    .map(({ code, name }) => ({ code, name }));

  return (
    <div className="space-y-6">
      <PageHeader title="Novo produto" description="Cria o produto e a primeira versão" />
      <ProductForm mainProducts={mainProducts} />
    </div>
  );
}
