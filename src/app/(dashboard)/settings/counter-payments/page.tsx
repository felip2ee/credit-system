import Link from "next/link";
import { redirect } from "next/navigation";

import { CounterPaymentForm } from "@/components/counter-payments/CounterPaymentForm";
import { CounterPaymentList } from "@/components/counter-payments/CounterPaymentList";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { toCents } from "@/lib/catalog/money";
import { CounterPaymentsOverview } from "@/components/counter-payments/CounterPaymentsOverview";
import { listCounterPayments } from "@/lib/counter-payments/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getDossierDetail } from "@/lib/dossiers/queries";
import { formatCurrency } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";
import { StatusBanner } from "@/components/ui/status-banner";

export const metadata = { title: "Pagamentos de balcão" };

export default async function CounterPaymentsPage({
  searchParams,
}: {
  searchParams: { dossier?: string; q?: string; filter?: string };
}) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "counter:read")) redirect("/");
  // Superadmin em suporte lê, mas não grava.
  const canWrite = hasPermission(session, "counter:write") && !session.supportSessionId;

  // Lista sem dossiê: vive na Carteira. Com ?dossier= (mesmo inválido) segue aqui.
  if (!searchParams.dossier) {
    const params = new URLSearchParams({ aba: "balcao" });
    if (searchParams.filter) params.set("filter", searchParams.filter);
    if (searchParams.q) params.set("q", searchParams.q);
    redirect(`/settings/wallet?${params}`);
  }

  const dossierId = isUuid(searchParams.dossier) ? searchParams.dossier : null;
  const detail = dossierId ? await getDossierDetail(session, dossierId) : null;

  if (!dossierId || !detail) {
    return (
      <div className="space-y-6">
        <PageHeader title="Pagamentos de balcão" description="Veja como cada pedido foi pago. Escolha um para ver ou registrar pagamentos" />
        {dossierId && !detail && (
          <StatusBanner tone="danger" title="Dossiê não encontrado." />
        )}
        <CounterPaymentsOverview session={session} filterParam={searchParams.filter} qParam={searchParams.q} />
      </div>
    );
  }

  const view = await withUserTransaction(session, (client) => listCounterPayments(client, dossierId));
  const remaining = view.price === null ? null : toCents(view.price) - toCents(view.paidTotal);
  const payments = view.payments.map((p) => ({
    id: p.id,
    method: p.method,
    amount: p.amount,
    receivedAt: p.receivedAt,
    note: p.note,
    voidedAt: p.voidedAt,
    voidReason: p.voidReason,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Pagamentos de balcão" description={detail.dossier.holder_name}>
        <Button asChild variant="outline">
          <Link href="/settings/wallet?aba=balcao">Outro Dossiê</Link>
        </Button>
      </PageHeader>
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted-foreground">Pago no balcão</p>
            <p className="text-2xl font-semibold">{formatCurrency(Number(view.paidTotal))}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Preço da liquidação</p>
            <p className="text-2xl font-semibold">{view.price === null ? "—" : formatCurrency(Number(view.price))}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Situação</p>
            <p className="text-lg">
              {remaining === null
                ? "Sem liquidação ainda"
                : remaining > 0
                  ? `Falta ${formatCurrency(remaining / 100)}`
                  : "Quitado"}
            </p>
          </div>
        </CardContent>
      </Card>
      {canWrite && <CounterPaymentForm dossierId={dossierId} />}
      <CounterPaymentList key={payments[0]?.id ?? "empty"} payments={payments} canWrite={canWrite} />
    </div>
  );
}
