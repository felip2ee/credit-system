import Link from "next/link";
import { redirect } from "next/navigation";
import { Banknote } from "lucide-react";

import { WithdrawalForm } from "@/components/affiliates/withdrawal-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { listMyWithdrawals, readWithdrawalFee } from "@/lib/affiliates/withdrawals";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { readAffiliateWithdrawalsEnabled } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateSP } from "@/lib/utils";

export const metadata = { title: "Saque de comissão" };

export default async function AffiliateWithdrawalPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read")) redirect("/portal");

  const withdrawalsEnabled = readAffiliateWithdrawalsEnabled(process.env);
  // A taxa vem da função SQL de saque: o cliente não lê settings (RLS), e a mesma leitura cobra o pedido.
  const [summary, fee, withdrawals] = await Promise.all([
    withUserTransaction(session, (client) => getMyAffiliateSummary(client)),
    readWithdrawalFee(session),
    listMyWithdrawals(session),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Saque de comissão" />
      <Link href="/portal/afiliacao" className="inline-flex min-h-12 items-center underline">
        Voltar para afiliação
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Solicitar saque</CardTitle>
          <p className="text-base text-muted-foreground">
            Disponível para saque: {formatCurrency(Number(summary?.wallet.available ?? "0"))}
          </p>
        </CardHeader>
        <CardContent>
          {withdrawalsEnabled ? (
            <WithdrawalForm fee={fee} />
          ) : (
            <p className="text-base text-muted-foreground">Saque disponível em breve.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Seus saques</CardTitle>
        </CardHeader>
        <CardContent>
          {withdrawals.length === 0 ? (
            <EmptyState icon={Banknote} title="Você ainda não pediu nenhum saque" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Chave PIX</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>{formatDateSP(w.createdAt)}</TableCell>
                    <TableCell>{w.pixKeyMasked}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(w.amount))}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(w.net))}</TableCell>
                    <TableCell>
                      <StatusBadge tone={statusInfo("withdrawal", w.status, "client").tone} label={statusInfo("withdrawal", w.status, "client").label} />
                      {w.status === "cancelled" && w.cancelReason && (
                        <p className="mt-1 text-muted-foreground">{w.cancelReason}</p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
