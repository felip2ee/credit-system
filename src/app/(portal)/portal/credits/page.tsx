import Link from "next/link";
import { redirect } from "next/navigation";
import { QrCode } from "lucide-react";

import { ClientBalance } from "@/components/credits/ClientBalance";
import { ClientLedgerTable } from "@/components/credits/ClientLedgerTable";
import { ClientTopupDialog } from "@/components/credits/ClientTopupDialog";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
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
              <p className="text-base font-bold">Confirme seu e-mail para comprar créditos.</p>
            ))}
        </ClientBalance>
      ) : (
        <StatusBanner tone="attention" title="Não encontramos sua carteira." description="Fale com o suporte para resolver." />
      )}
      {data.charges.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Recargas recentes" />
          <Card>
            <ul className="divide-y divide-border">
              {data.charges.slice(0, RECENT_CHARGES).map((c) => (
                <li key={c.id}>
                  <ListRow
                    icon={QrCode}
                    title={formatCurrency(Number(c.amount))}
                    subtitle={
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>{formatDateTime(c.createdAt)}</span>
                        <StatusBadge tone={CHARGE_STATUS[c.status].tone} label={CHARGE_STATUS[c.status].label} />
                        {c.status === "paid" && (
                          <Link href={`/portal/credits/receipts/${c.id}`} className="inline-flex min-h-12 items-center font-bold text-primary underline">
                            Recibo
                          </Link>
                        )}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
      <ClientLedgerTable
        key={ledgerRows[0]?.id ?? "empty"}
        initialRows={ledgerRows}
        initialCursor={data.ledger.nextCursor}
      />
    </div>
  );
}
