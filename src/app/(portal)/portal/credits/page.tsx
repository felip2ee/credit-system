import Link from "next/link";
import { redirect } from "next/navigation";

import { ClientBalance } from "@/components/credits/ClientBalance";
import { ClientLedgerTable } from "@/components/credits/ClientLedgerTable";
import { ClientTopupDialog } from "@/components/credits/ClientTopupDialog";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getClientAccountStatus } from "@/lib/account/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { getClientWallet, listClientLedger } from "@/lib/wallet/client-queries";
import { listClientPixCharges, type PixChargeStatus } from "@/lib/wallet/pix-charges";

export const metadata = { title: "Créditos" };

const STATUS_LABEL: Record<PixChargeStatus, string> = {
  pending: "Aguardando pagamento",
  paid: "Pago",
  expired: "Expirado",
  cancelled: "Cancelado",
  refunded: "Estornado",
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
              <p className="text-sm text-muted-foreground">Confirme seu e-mail para comprar créditos.</p>
            ))}
        </ClientBalance>
      ) : (
        <p className="text-sm text-muted-foreground">Carteira não encontrada. Contate o suporte.</p>
      )}
      {data.charges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recargas recentes</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {data.charges.slice(0, RECENT_CHARGES).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {formatCurrency(Number(c.amount))} · {formatDateTime(c.createdAt)}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">{STATUS_LABEL[c.status]}</span>
                    {c.status === "paid" && (
                      <Link href={`/portal/credits/receipts/${c.id}`} className="underline">
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
