import { Coins, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AffiliateCommissionRow, AffiliateReferralRow } from "@/lib/affiliates/types";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateSP } from "@/lib/utils";

import { commissionStatusLabel } from "./affiliate-rules";

interface CommissionTablesProps {
  referrals: AffiliateReferralRow[];
  commissions: AffiliateCommissionRow[];
}

export function CommissionTables({ referrals, commissions }: CommissionTablesProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Indicados</CardTitle>
        </CardHeader>
        <CardContent>
          {referrals.length === 0 ? (
            <EmptyState icon={Users} title="Ninguém se cadastrou pelo seu link ainda" description="Envie seu link de indicação para começar." />
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
          <CardTitle className="text-xl">Comissões</CardTitle>
        </CardHeader>
        <CardContent>
          {commissions.length === 0 ? (
            <EmptyState icon={Coins} title="Você ainda não tem comissões" description="Elas aparecem quando um indicado fizer um pedido." />
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
                      <StatusBadge tone={statusInfo("commission", c.status, "client").tone} label={commissionStatusLabel(c.status, c.releaseAt)} />
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
