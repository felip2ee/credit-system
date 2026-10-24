import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AffiliateCommissionRow, AffiliateReferralRow, CommissionStatus } from "@/lib/affiliates/types";
import { formatCurrency, formatDateSP } from "@/lib/utils";

import { commissionStatusLabel } from "./affiliate-rules";

const STATUS_VARIANT: Record<CommissionStatus, "secondary" | "default" | "destructive"> = {
  pending: "secondary",
  released: "default",
  reversed: "destructive",
};

interface CommissionTablesProps {
  referrals: AffiliateReferralRow[];
  commissions: AffiliateCommissionRow[];
}

export function CommissionTables({ referrals, commissions }: CommissionTablesProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Indicados</CardTitle>
        </CardHeader>
        <CardContent>
          {referrals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguém se cadastrou pelo seu link ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Cadastro</TableHead>
                  <TableHead className="text-right">Total gasto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.map((r, index) => (
                  <TableRow key={`${r.createdAt}-${index}`}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{formatDateSP(r.createdAt)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(r.totalSpent))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Comissões</CardTitle>
        </CardHeader>
        <CardContent>
          {commissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Você ainda não tem comissões.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Indicado</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Pedido</TableHead>
                  <TableHead className="text-right">Comissão</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commissions.map((c, index) => (
                  <TableRow key={`${c.createdAt}-${index}`}>
                    <TableCell>{formatDateSP(c.createdAt)}</TableCell>
                    <TableCell>{c.referredName}</TableCell>
                    <TableCell>{c.productName}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(c.orderValue))}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(c.amount))}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[c.status]}>{commissionStatusLabel(c.status, c.releaseAt)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
