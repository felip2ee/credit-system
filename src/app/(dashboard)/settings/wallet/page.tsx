import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { DebtNote } from "@/components/wallet/DebtNote";
import { PayoutsTab } from "@/components/wallet/PayoutsTab";
import { SalesTab } from "@/components/wallet/SalesTab";
import { StatementTab } from "@/components/wallet/StatementTab";
import { TopupDialog } from "@/components/wallet/TopupDialog";
import { WalletBalance } from "@/components/wallet/WalletBalance";
import { WalletTabs } from "@/components/wallet/WalletTabs";
import type { Chip } from "@/components/wallet/FilterChips";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { parseRevenuePeriod, revenueRange, REVENUE_PERIODS } from "@/lib/dashboard/period";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getPayableBuckets, PayableBucketsRefusedError, type PayableBuckets } from "@/lib/payables/queries";
import { readPayableRetentionDays } from "@/lib/settings/readers";
import { walletHref } from "@/lib/wallet/href";
import { formatMoney } from "@/lib/wallet/money";
import { getWallet } from "@/lib/wallet/queries";
import { listPixCharges } from "@/lib/wallet/pix-charges";
import { listSales } from "@/lib/wallet/sales";
import { payableOwed } from "@/lib/wallet/payable-summary";
import { parseStatementSource, visibleStatementSources } from "@/lib/wallet/statement-source";
import { listWalletStatement } from "@/lib/wallet/statement-total";
import { parseWalletTab, visibleWalletTabs } from "@/lib/wallet/tabs";

export const metadata = { title: "Carteira" };

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v);

export default async function WalletPage({
  searchParams,
}: {
  searchParams: { aba?: Param; periodo?: Param; fonte?: Param; cursor?: Param };
}) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "wallet:read") || !session.bureauId) redirect("/");

  const { bureauId } = session;
  // Suporte não lê repasse (a RLS também barra).
  const roleCanPayout = hasPermission(session, "payout:read") && !session.supportSessionId;

  const base = await withUserTransaction(session, async (client) => {
    let buckets: PayableBuckets | null = null;
    if (roleCanPayout) {
      // Sem acesso, a consulta recusa: esconde o "A receber" em vez de mostrar zero.
      buckets = await getPayableBuckets(client, bureauId).catch((err) => {
        if (err instanceof PayableBucketsRefusedError) return null;
        throw err;
      });
    }
    return { wallet: await getWallet(client, bureauId), charges: await listPixCharges(client, bureauId), buckets };
  });

  const tabs = visibleWalletTabs({ payout: base.buckets !== null, counter: hasPermission(session, "counter:read") });
  const tab = parseWalletTab(first(searchParams.aba), tabs);
  const periodKey = parseRevenuePeriod(first(searchParams.periodo));
  const range = revenueRange(periodKey);
  const rawCursor = first(searchParams.cursor) ?? null;
  const sources = visibleStatementSources(roleCanPayout);
  const source = parseStatementSource(first(searchParams.fonte), roleCanPayout);

  // Link da aba atual com os filtros; "mes" e "all" são os padrões e saem da URL.
  const link = (over: Record<string, string | null> = {}) =>
    walletHref({
      aba: tab === "online" ? null : tab,
      periodo: periodKey === "mes" ? null : periodKey,
      fonte: tab === "extrato" && source !== "all" ? source : null,
      ...over,
    });
  const periodChips: Chip[] = REVENUE_PERIODS.map((p) => ({
    key: p.key,
    label: p.label,
    href: link({ periodo: p.key === "mes" ? null : p.key, cursor: null }),
  }));
  const startHref = rawCursor ? link({ cursor: null }) : null;
  const next = (cursor: string | null) => (cursor ? link({ cursor }) : null);

  let content: React.ReactNode = null;
  try {
    if (tab === "online" || tab === "balcao") {
      const page = await withUserTransaction(session, (client) =>
        listSales(client, { mode: tab === "online" ? "online" : "counter", range, cursor: rawCursor }),
      );
      content = (
        <SalesTab
          mode={tab === "online" ? "online" : "counter"}
          page={page}
          periodChips={periodChips}
          period={periodKey}
          nextHref={next(page.nextCursor)}
          startHref={startHref}
          detailLinks={hasPermission(session, "counter:read")}
        />
      );
    } else if (tab === "extrato") {
      const page = await withUserTransaction(session, (client) =>
        listWalletStatement(client, { bureauId, source, includePayable: roleCanPayout, range, cursor: rawCursor }),
      );
      content = (
        <StatementTab
          page={page}
          sourceChips={sources.map((s) => ({ ...s, href: link({ fonte: s.key === "all" ? null : s.key, cursor: null }) }))}
          source={source}
          periodChips={periodChips}
          period={periodKey}
          nextHref={next(page.nextCursor)}
          startHref={startHref}
        />
      );
    } else if (base.buckets) {
      content = (
        <PayoutsTab
          buckets={base.buckets}
          retentionDays={await readPayableRetentionDays(session)}
          session={session}
          bureauId={bureauId}
        />
      );
    }
  } catch (err) {
    // Cursor adulterado na URL: volta ao início da lista.
    if (err instanceof RangeError) redirect(link({ cursor: null }));
    throw err;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Carteira" description="Saldo, valores a receber e pagamentos do seu Bureau" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {base.wallet ? (
          <WalletBalance wallet={base.wallet}>
            {hasPermission(session, "wallet:topup") && (
              <TopupDialog charges={base.charges.map(({ id, status }) => ({ id, status }))} />
            )}
          </WalletBalance>
        ) : (
          <p className="text-sm text-muted-foreground">Carteira não encontrada.</p>
        )}
        {base.buckets && (
          <Card className="space-y-1 self-start p-4 md:p-5">
            <h2 className="text-base">A receber</h2>
            <p className="text-3xl font-bold md:text-4xl leading-tight tabular-nums [overflow-wrap:anywhere]">
              {formatMoney(payableOwed(base.buckets))}
            </p>
            <p className="text-base text-muted-foreground">Lucro dos pedidos online que a Rainha Cred vai repassar a você.</p>
            <DebtNote debt={base.buckets.debt} />
          </Card>
        )}
      </div>
      <WalletTabs tabs={tabs} active={tab} />
      {content}
    </div>
  );
}
