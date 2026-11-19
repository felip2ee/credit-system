import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getRequiredSession } from "@/lib/auth/session";
import { commissionCents } from "@/lib/catalog/build-quote";
import { fromCents, toCents } from "@/lib/catalog/money";
import { getEffectiveCommission, listCatalog, pctToHundredths } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Catálogo" };

// Somente leitura: preço, % de comissão e bloqueio de produto são da plataforma.
export default async function CatalogPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "catalog:read")) redirect("/");

  const [entries, commission] = await Promise.all([
    listCatalog(session),
    getEffectiveCommission(session, session.bureauId),
  ]);
  const hundredths = commission.pct === null ? null : pctToHundredths(commission.pct);
  const earns = (price: string) =>
    hundredths === null ? null : formatCurrency(Number(fromCents(commissionCents(toCents(price), hundredths))));

  return (
    <div className="space-y-6">
      <PageHeader title="Catálogo" description="Produtos à venda no seu Bureau e quanto você ganha em cada venda" />
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sua comissão</CardTitle>
          <CardDescription>
            A plataforma define os preços, a sua porcentagem e quais produtos ficam à venda. Você ganha essa
            porcentagem sobre o preço de cada venda.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {commission.pct === null ? (
            <p className="text-sm text-muted-foreground">
              A plataforma ainda não definiu a sua comissão. Enquanto isso, as vendas ficam indisponíveis.
            </p>
          ) : (
            <p className="text-2xl font-semibold">{Number(commission.pct)}%</p>
          )}
        </CardContent>
      </Card>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum produto à venda no momento. Fale com a plataforma.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Preço de venda</TableHead>
              <TableHead>Por sócio</TableHead>
              <TableHead>Você ganha por venda</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => {
              const perPartner = Number(e.salePricePerPartner) > 0;
              const base = earns(e.salePrice);
              const partner = perPartner ? earns(e.salePricePerPartner) : null;
              return (
                <TableRow key={e.productId}>
                  <TableCell className="font-medium">{e.name}</TableCell>
                  <TableCell>{formatCurrency(Number(e.salePrice))}</TableCell>
                  <TableCell>{perPartner ? formatCurrency(Number(e.salePricePerPartner)) : "—"}</TableCell>
                  <TableCell>
                    {base ?? "—"}
                    {partner && ` + ${partner} por sócio`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
