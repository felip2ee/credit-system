import { StackedList, StackedRow } from "@/components/dashboard/stacked-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BureauAffiliate } from "@/lib/affiliates/rates";
import { formatCurrency } from "@/lib/utils";

interface BureauAffiliatesTableProps {
  defaultPct: string;
  affiliates: BureauAffiliate[];
}

// Só leitura: a % de afiliados do Bureau é definida pelo superadmin.
export function BureauAffiliatesTable({ defaultPct, affiliates }: BureauAffiliatesTableProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Comissão de afiliados</CardTitle>
          <CardDescription>
            Vale para todos os afiliados do Bureau. Quem define a porcentagem é a plataforma.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-semibold">{defaultPct}%</p>
        </CardContent>
      </Card>
      {affiliates.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum afiliado ainda.</p>
      ) : (
        <>
          <Card className="md:hidden">
            <StackedList>
              {affiliates.map((a) => (
                <StackedRow
                  key={a.profileId}
                  title={a.name}
                  meta={
                    <>
                      Código <span className="font-mono">{a.code}</span> · {a.referrals} {a.referrals === 1 ? "indicado" : "indicados"}
                    </>
                  }
                  aside={formatCurrency(Number(a.totalCommission))}
                />
              ))}
            </StackedList>
          </Card>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Indicados</TableHead>
                  <TableHead>Total de comissão</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affiliates.map((a) => (
                  <TableRow key={a.profileId}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="font-mono text-sm">{a.code}</TableCell>
                    <TableCell>{a.referrals}</TableCell>
                    <TableCell>{formatCurrency(Number(a.totalCommission))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
