import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/layout/page-header";
import { formatBRL } from "@/components/superadmin/money";
import { ProductEditForm } from "@/components/superadmin/product-form";
import { ProductVersionForm } from "@/components/superadmin/product-version-form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { listProductVersions, listProducts } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Produto" };

export default async function ProductDetailPage({ params }: { params: { id: string } }) {
  if (!z.string().uuid().safeParse(params.id).success) notFound();
  const session = await getRequiredSession();
  if (!hasPermission(session, "catalog:read")) notFound();
  const canWrite = hasPermission(session, "catalog:write");

  const [products, versions] = await Promise.all([
    listProducts(session),
    listProductVersions(session, params.id),
  ]);
  const product = products.find((p) => p.id === params.id);
  if (!product) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={product.name} description={`Código: ${product.code}`} />
      {canWrite && <ProductEditForm product={product} />}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Versões</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Versão</TableHead>
              <TableHead>Nome DEPS</TableHead>
              <TableHead className="text-right">Custo padrão</TableHead>
              <TableHead>Criada em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v) => (
              <TableRow key={v.id}>
                <TableCell>v{v.version}</TableCell>
                <TableCell>{v.depsProduct ?? "—"}</TableCell>
                <TableCell className="text-right">{formatBRL(v.baseCost)}</TableCell>
                <TableCell>{v.createdAt.toLocaleString("pt-BR")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {canWrite && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Nova versão</h2>
          <p className="text-sm text-muted-foreground">
            A versão anterior não muda. Pedidos futuros usam a nova versão.
          </p>
          <ProductVersionForm
            productId={product.id}
            currentDepsProduct={product.depsProduct}
            currentBaseCost={product.baseCost}
          />
        </section>
      )}
    </div>
  );
}
