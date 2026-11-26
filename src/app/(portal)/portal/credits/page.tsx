import { redirect } from "next/navigation";

import { ClientBalance } from "@/components/credits/ClientBalance";
import { ClientStatement } from "@/components/credits/ClientStatement";
import { PendingChargeButton } from "@/components/credits/PendingChargeButton";
import { toCents } from "@/lib/catalog/money";
import { referencePriceRows } from "@/lib/catalog/reference-prices";
import type { ChargeSummary } from "@/lib/wallet/pix-fees";
import { ClientTopupDialog } from "@/components/credits/ClientTopupDialog";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getClientWallet, listClientLedger } from "@/lib/wallet/client-queries";
import { listClientPixCharges } from "@/lib/wallet/pix-charges";

export const metadata = { title: "Créditos" };

// Sem total gravado = sem taxa (total = recarga).
const summaryOf = (c: { amount: string; feeAmount: string; totalCharged: string | null }): ChargeSummary => ({
	rechargeCents: toCents(c.amount),
	feeCents: toCents(c.feeAmount),
	totalCents: toCents(c.totalCharged ?? c.amount),
});

export default async function ClientCreditsPage({ searchParams }: { searchParams: { pix?: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "credits:read")) redirect("/portal");

  const data = await withUserTransaction(session, async (client) => ({
    slug: (await client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()")).rows[0]?.slug ?? null,
    status: await getClientAccountStatus(client, session.userId),
    wallet: await getClientWallet(client, session.userId),
    ledger: await listClientLedger(client, session.userId),
    charges: await listClientPixCharges(client, session.userId),
  }));

  const catalog = data.slug ? await getPublicCatalog(data.slug) : [];
  const priceRows = referencePriceRows(
    catalog.find((item) => item.code === "dossie_pf"),
    catalog.find((item) => item.code === "dossie_empresarial"),
  );

  const extras = Object.fromEntries(
    data.charges.flatMap((c) =>
      c.status === "pending" && c.pixPayload
        ? [[`charge:${c.id}`, <PendingChargeButton key={c.id} pixPayload={c.pixPayload} summary={summaryOf(c)} defaultOpen={searchParams.pix === c.id} />]]
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
              <ClientTopupDialog priceRows={priceRows} />
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
