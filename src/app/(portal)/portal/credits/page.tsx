import { redirect } from "next/navigation";

import { ClientBalance } from "@/components/credits/ClientBalance";
import { ClientStatement } from "@/components/credits/ClientStatement";
import { PendingChargeButton } from "@/components/credits/PendingChargeButton";
import { ClientTopupDialog } from "@/components/credits/ClientTopupDialog";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getClientAccountStatus } from "@/lib/account/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getClientWallet, listClientLedger } from "@/lib/wallet/client-queries";
import { listClientPixCharges } from "@/lib/wallet/pix-charges";

export const metadata = { title: "Créditos" };

export default async function ClientCreditsPage({ searchParams }: { searchParams: { pix?: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "credits:read")) redirect("/portal");

  const data = await withUserTransaction(session, async (client) => ({
    status: await getClientAccountStatus(client, session.userId),
    wallet: await getClientWallet(client, session.userId),
    ledger: await listClientLedger(client, session.userId),
    charges: await listClientPixCharges(client, session.userId),
  }));

  const extras = Object.fromEntries(
    data.charges.flatMap((c) =>
      c.status === "pending" && c.pixPayload
        ? [[`charge:${c.id}`, <PendingChargeButton key={c.id} pixPayload={c.pixPayload} defaultOpen={searchParams.pix === c.id} />]]
        : [],
    ),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Créditos" description="Saldo, recargas por PIX e extrato" />
      {data.wallet ? (
        <ClientBalance wallet={data.wallet}>
          {hasPermission(session, "credits:topup") &&
            (data.status.emailVerified ? (
              <ClientTopupDialog />
            ) : (
              <p className="text-base font-bold">Confirme seu e-mail para comprar créditos.</p>
            ))}
        </ClientBalance>
      ) : (
        <StatusBanner tone="attention" title="Não encontramos sua carteira." description="Fale com o suporte para resolver." />
      )}
      <ClientStatement initialLedger={data.ledger.rows} initialCursor={data.ledger.nextCursor} charges={data.charges} extras={extras} />
    </div>
  );
}
