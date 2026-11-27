import { redirect } from "next/navigation";
import { Banknote } from "lucide-react";

import { WithdrawalForm } from "@/components/affiliates/withdrawal-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
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
      <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title="Saque de comissão" backHref="/portal/afiliacao" backLabel="Voltar para afiliação" />
      <Card>
        <CardHeader>
          <CardTitle>Solicitar saque</CardTitle>
          <p className="text-sm text-muted-foreground">
            Disponível para saque: {formatCurrency(Number(summary?.wallet.available ?? "0"))}
          </p>
        </CardHeader>
        <CardContent>
          {withdrawalsEnabled ? (
            <WithdrawalForm fee={fee} />
          ) : (
            <p className="text-sm text-muted-foreground">Saque disponível em breve.</p>
          )}
        </CardContent>
      </Card>
      <section className="space-y-3">
        <SectionHeader title="Seus saques" />
        {withdrawals.length === 0 ? (
          <Card>
            <EmptyState icon={Banknote} title="Você ainda não pediu nenhum saque" />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {withdrawals.map((w) => {
                const info = statusInfo("withdrawal", w.status, "client");
                return (
                  <li key={w.id}>
                    <ListRow
                      icon={Banknote}
                      title={`${formatCurrency(Number(w.amount))} · líquido ${formatCurrency(Number(w.net))}`}
                      subtitle={
                        <span className="block space-y-1">
                          <span className="block">
                            {formatDateSP(w.createdAt)} · Chave PIX {w.pixKeyMasked}
                          </span>
                          <StatusBadge tone={info.tone} label={info.label} />
                          {w.status === "cancelled" && w.cancelReason && <span className="block">{w.cancelReason}</span>}
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
