import Link from "next/link";
import { redirect } from "next/navigation";

import { WithdrawalForm } from "@/components/affiliates/withdrawal-form";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMyAffiliateSummary } from "@/lib/affiliates/queries";
import { listMyWithdrawals, type WithdrawalStatus } from "@/lib/affiliates/withdrawals";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { readAffiliateSettings } from "@/lib/settings/readers";
import { formatCurrency, formatDateSP } from "@/lib/utils";

export const metadata = { title: "Saque de comissão" };

const STATUS_LABEL: Record<WithdrawalStatus, string> = { open: "Em análise", paid: "Pago", cancelled: "Cancelado" };
const STATUS_VARIANT: Record<WithdrawalStatus, "secondary" | "default" | "destructive"> = {
  open: "secondary",
  paid: "default",
  cancelled: "destructive",
};

export default async function AffiliateWithdrawalPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "affiliates:read")) redirect("/portal");

  const [summary, settings, withdrawals] = await Promise.all([
    withUserTransaction(session, (client) => getMyAffiliateSummary(client)),
    readAffiliateSettings(session),
    listMyWithdrawals(session),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Saque de comissão" />
      <Link href="/portal/afiliacao" className="text-sm underline">
        Voltar para afiliação
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Solicitar saque</CardTitle>
          <p className="text-sm text-muted-foreground">
            Disponível para saque: {formatCurrency(Number(summary?.wallet.available ?? "0"))}
          </p>
        </CardHeader>
        <CardContent>
          <WithdrawalForm fee={settings.withdrawalFee} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Seus saques</CardTitle>
        </CardHeader>
        <CardContent>
          {withdrawals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Você ainda não pediu nenhum saque.</p>
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
                      <Badge variant={STATUS_VARIANT[w.status]}>{STATUS_LABEL[w.status]}</Badge>
                      {w.status === "cancelled" && w.cancelReason && (
                        <p className="mt-1 text-xs text-muted-foreground">{w.cancelReason}</p>
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
