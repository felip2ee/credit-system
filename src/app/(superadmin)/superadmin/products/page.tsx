import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { formatBRL } from "@/components/superadmin/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { listProducts } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Produtos" };

export default async function ProductsPage() {
  const session = await getRequiredSession();
  if (session.role !== "superadmin" || !hasPermission(session, "catalog:read")) notFound();
  const products = await listProducts(session);
  const canWrite = hasPermission(session, "catalog:write");

  return (
    <div className="space-y-6">
      <PageHeader title="Produtos" description="Produtos base, versões e custo padrão">
        {canWrite && (
          <Button asChild>
            <Link href="/superadmin/products/new">Novo produto</Link>
          </Button>
        )}
      </PageHeader>
      <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead>
            <TableHead>Nome</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Versão vigente</TableHead>
            <TableHead className="text-right">Custo padrão</TableHead>
            <TableHead className="text-right">Custo por sócio</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.code}</TableCell>
              <TableCell>
                <Link className="font-medium hover:underline" href={`/superadmin/products/${p.id}`}>
                  {p.name}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant={p.active ? "success" : "muted"}>{p.active ? "Ativo" : "Inativo"}</Badge>
              </TableCell>
              <TableCell>v{p.version}</TableCell>
              <TableCell className="text-right">{formatBRL(p.baseCost)}</TableCell>
              <TableCell className="text-right">
                {p.code === "dossie_empresarial" ? formatBRL(p.baseCostPerPartner) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </Card>
    </div>
  );
}
