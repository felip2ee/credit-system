import Link from "next/link";
import { redirect } from "next/navigation";

import { ClientBalance } from "@/components/credits/ClientBalance";
import { ClientLedgerTable } from "@/components/credits/ClientLedgerTable";
import { ClientTopupDialog } from "@/components/credits/ClientTopupDialog";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
import type { StateTone } from "@/components/ui/state-tone";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getClientAccountStatus } from "@/lib/account/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { getClientWallet, listClientLedger } from "@/lib/wallet/client-queries";
import { listClientPixCharges, type PixChargeStatus } from "@/lib/wallet/pix-charges";

export const metadata = { title: "Créditos" };

const CHARGE_STATUS: Record<PixChargeStatus, { tone: StateTone; label: string }> = {
  pending: { tone: "waiting", label: "Aguardando pagamento" },
  paid: { tone: "success", label: "Pago" },
  expired: { tone: "neutral", label: "Expirado" },
  cancelled: { tone: "neutral", label: "Cancelado" },
  refunded: { tone: "attention", label: "Estornado" },
};

const RECENT_CHARGES = 5;

export default async function ClientCreditsPage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "credits:read")) redirect("/portal");

  const data = await withUserTransaction(session, async (client) => ({
    status: await getClientAccountStatus(client, session.userId),
    wallet: await getClientWallet(client, session.userId),
    ledger: await listClientLedger(client, session.userId),
    charges: await listClientPixCharges(client, session.userId),
  }));

  const ledgerRows = data.ledger.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: r.amount,
    availableAfter: r.availableAfter,
    reservedAfter: r.reservedAfter,
    reason: r.reason,
    createdAt: r.createdAt,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Créditos" description="Saldo, recargas por PIX e extrato" />
      {data.wallet ? (
        <ClientBalance wallet={data.wallet}>
          {hasPermission(session, "credits:topup") &&
            (data.status.emailVerified ? (
              <ClientTopupDialog charges={data.charges.map(({ id, status }) => ({ id, status }))} />
            ) : (
              <p className="text-muted-foreground">Confirme seu e-mail para comprar créditos.</p>
            ))}
        </ClientBalance>
      ) : (
        <StatusBanner tone="attention" title="Não encontramos sua carteira." description="Fale com o suporte para resolver." />
      )}
      {data.charges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Recargas recentes</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {data.charges.slice(0, RECENT_CHARGES).map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span>
                    {formatCurrency(Number(c.amount))} · {formatDateTime(c.createdAt)}
                  </span>
                  <span className="flex items-center gap-3">
                    <StatusBadge tone={CHARGE_STATUS[c.status].tone} label={CHARGE_STATUS[c.status].label} />
                    {c.status === "paid" && (
                      <Link href={`/portal/credits/receipts/${c.id}`} className="inline-flex min-h-12 items-center underline">
                        Recibo
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <ClientLedgerTable
        key={ledgerRows[0]?.id ?? "empty"}
        initialRows={ledgerRows}
        initialCursor={data.ledger.nextCursor}
      />
    </div>
  );
}
