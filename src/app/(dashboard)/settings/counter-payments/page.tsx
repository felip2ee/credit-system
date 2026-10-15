import Link from "next/link";
import { redirect } from "next/navigation";

import { CounterPaymentForm } from "@/components/counter-payments/CounterPaymentForm";
import { CounterPaymentList } from "@/components/counter-payments/CounterPaymentList";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { toCents } from "@/lib/catalog/money";
import { listCounterPayments } from "@/lib/counter-payments/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getDossierDetail, listDossiers } from "@/lib/dossiers/queries";
import { formatCurrency, formatDateSP } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Pagamentos de balcão" };

const MAX_DOSSIERS = 20;

export default async function CounterPaymentsPage({
  searchParams,
}: {
  searchParams: { dossier?: string; q?: string };
}) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "counter:read")) redirect("/");
  // Superadmin em suporte lê, mas não grava.
  const canWrite = hasPermission(session, "counter:write") && !session.supportSessionId;

  const dossierId = isUuid(searchParams.dossier) ? searchParams.dossier : null;
  const detail = dossierId ? await getDossierDetail(session, dossierId) : null;

  if (!dossierId || !detail) {
    const dossiers = (await listDossiers(session, { q: searchParams.q })).slice(0, MAX_DOSSIERS);
    return (
      <div className="space-y-6">
        <PageHeader title="Pagamentos de balcão" description="Escolha o Dossiê para ver ou registrar pagamentos" />
        {dossierId && !detail && (
          <p role="alert" className="text-sm text-destructive">
            Dossiê não encontrado.
          </p>
        )}
        <form action="/settings/counter-payments" className="flex max-w-md gap-2">
          <Input
            name="q"
            aria-label="Buscar por nome, CPF ou CNPJ"
            placeholder="Buscar por nome, CPF ou CNPJ..."
            defaultValue={searchParams.q ?? ""}
          />
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>
        <Card>
          <CardContent className="p-0">
            {dossiers.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Nenhuma pesquisa encontrada.</p>
            ) : (
              <ul className="divide-y">
                {dossiers.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/settings/counter-payments?dossier=${d.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/50"
                    >
                      <span className="truncate font-medium">{d.holder_name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDateSP(d.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
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
          <Link href="/settings/counter-payments">Outro Dossiê</Link>
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
