import Link from "next/link";
import { HandCoins, Search, TrendingUp, Users, Wallet } from "lucide-react";
import { redirect } from "next/navigation";

import { HideableStat } from "@/components/dashboard/hideable-stat";
import { Stat } from "@/components/dashboard/stat";
import { PageHeader } from "@/components/layout/page-header";
import { LineChart } from "@/components/reports/line-chart";
import { HUE } from "@/components/reports/palette";
import { PieChart } from "@/components/reports/pie-chart";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { SegmentedNav } from "@/components/ui/segmented-nav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getRequiredSession } from "@/lib/auth/session";
import { formatCurrency } from "@/lib/utils";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { canViewRevenue } from "@/lib/dashboard/access";
import { getDashboardMetrics, getRevenueSummary } from "@/lib/dashboard/queries";
import { parseRevenuePeriod, revenueRange, REVENUE_PERIODS } from "@/lib/dashboard/period";
import { getPayableBalance } from "@/lib/payables/queries";
import { getWallet } from "@/lib/wallet/queries";
import { type EntityKind } from "@/types/app";

// Limites de período no fuso de Brasília (UTC-3, sem horário de verão).
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTH_ABBR = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];
const HISTORY_MONTHS = 12;
const QUERY_MONTHS = 6;

function brBoundaries() {
  const br = new Date(Date.now() - BR_OFFSET_MS);
  const startToday = new Date(
    Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate()) + BR_OFFSET_MS
  ).toISOString();
  const startMonth = new Date(
    Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1) + BR_OFFSET_MS
  ).toISOString();
  return { startToday, startMonth };
}

function lastMonths(count: number): { year: number; month: number; label: string }[] {
  const br = new Date(Date.now() - BR_OFFSET_MS);
  const out: { year: number; month: number; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth() - i, 1));
    out.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      label: MONTH_ABBR[d.getUTCMonth()],
    });
  }
  return out;
}

function monthStartISO(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1) + BR_OFFSET_MS).toISOString();
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { periodo?: string | string[] };
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));

  const periodKey = parseRevenuePeriod(searchParams.periodo);
  const periodLabel = REVENUE_PERIODS.find((p) => p.key === periodKey)?.label ?? "";
  const range = revenueRange(periodKey);

  const { startToday, startMonth } = brBoundaries();
  const months = lastMonths(HISTORY_MONTHS);
  const queryMonths = months.slice(-QUERY_MONTHS);

  const showRevenue = canViewRevenue(session);
  const [metrics, revenue] = await Promise.all([
    getDashboardMetrics(session, {
      startToday,
      startMonth,
      start6mo: monthStartISO(queryMonths[0].year, queryMonths[0].month),
    }),
    showRevenue
      ? getRevenueSummary(session, range, monthStartISO(months[0].year, months[0].month))
      : Promise.resolve(null),
  ]);
  const { counts } = metrics;

  // Saldos do Bureau: carteira pré-paga (todos) e valor a receber (só quem vê repasses).
  const { bureauId } = session;
  const balances = bureauId
    ? await withUserTransaction(session, async (client) => ({
        wallet: await getWallet(client, bureauId),
        payable: hasPermission(session, "payout:read") ? await getPayableBalance(client, bureauId) : null,
      }))
    : null;
  const payable = balances?.payable ?? null;

  // ── Histórico de faturamento (12 meses) ────────────────────
  const revenueByMonth = new Map((revenue?.monthly ?? []).map((r) => [r.month, r.amount]));
  const history = months.map((m) => ({
    key: `${m.year}-${String(m.month + 1).padStart(2, "0")}`,
    label: m.label,
    amount: revenueByMonth.get(`${m.year}-${String(m.month + 1).padStart(2, "0")}`) ?? 0,
  }));
  const historyMax = Math.max(1, ...history.map((h) => h.amount));

  // ── Consultas por mês (PF/PJ) ──────────────────────────────
  const monthData = queryMonths.map((m) => ({ label: m.label, pf: 0, pj: 0 }));
  let totalPf = 0;
  let totalPj = 0;
  const indexByKey = new Map(queryMonths.map((m, i) => [`${m.year}-${m.month}`, i]));
  for (const r of metrics.monthlyQueries as { created_at: string; type: EntityKind }[]) {
    const br = new Date(new Date(r.created_at).getTime() - BR_OFFSET_MS);
    const idx = indexByKey.get(`${br.getUTCFullYear()}-${br.getUTCMonth()}`);
    if (idx === undefined) continue;
    if (r.type === "PF") {
      monthData[idx].pf += 1;
      totalPf += 1;
    } else {
      monthData[idx].pj += 1;
      totalPj += 1;
    }
  }

  const orders = revenue?.total.orders ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader title="Início" description={showRevenue ? "Vendas, faturamento e repasse do seu Bureau" : "Consultas e carteira do seu Bureau"}>
        {hasPermission(session, "consultations:write") && (
          <Button asChild variant="cta">
            <Link href="/dossiers/new">Novo pedido de balcão</Link>
          </Button>
        )}
      </PageHeader>

      <section className="space-y-3">
        <SectionHeader title="Números principais" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {revenue && (
            <HideableStat
              label="Faturamento total"
              value={formatCurrency(revenue.total.amount)}
              hint={`${orders} ${orders === 1 ? "pedido concluído" : "pedidos concluídos"} desde o início`}
              icon={<TrendingUp className="size-[18px]" />}
            />
          )}
          {payable !== null && (
            <Stat label="A receber" value={formatCurrency(Number(payable))} hint="Repasse pendente da Rainha Cred" icon={HandCoins} href="/settings/wallet?aba=receber" />
          )}
          <Stat label="Consultas hoje" value={String(counts.today)} hint="Criadas hoje" icon={Search} href="/dossiers" />
          <Stat label="Consultas no mês" value={String(counts.month)} hint="Mês corrente" icon={Search} href="/dossiers" />
          {balances && (
            <Stat label="Saldo da carteira" value={formatCurrency(Number(balances.wallet?.available ?? 0))} hint="Créditos pré-pagos" icon={Wallet} href="/settings/wallet" />
          )}
          {revenue && <Stat label="Clientes" value={String(revenue.clients)} hint="Cadastrados no portal" icon={Users} />}
        </div>
      </section>

      {revenue && (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader title="Faturamento do período" />
          <SegmentedNav
            label="Período"
            activeKey={periodKey}
            items={REVENUE_PERIODS.map((p) => ({ key: p.key, label: p.label, href: p.key === "mes" ? "/" : `/?periodo=${p.key}` }))}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat label={`Faturado: ${periodLabel.toLowerCase()}`} value={formatCurrency(revenue.period.amount)} hint="Pedidos concluídos no período" icon={TrendingUp} />
          <Stat
            label="Vendas no período"
            value={String(revenue.period.orders)}
            hint={revenue.period.orders > 0 ? `Ticket médio ${formatCurrency(revenue.period.amount / revenue.period.orders)}` : "Nenhum pedido concluído"}
            icon={Search}
          />
        </div>
      </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Consultas por mês</CardTitle>
          <CardDescription>Últimos {QUERY_MONTHS} meses, PF e PJ</CardDescription>
        </CardHeader>
        <CardContent>
          {totalPf + totalPj === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma consulta no período.</p>
          ) : (
            <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-2">
              <PieChart
                size={132}
                segments={[
                  { label: "PF", value: totalPf, fillClass: HUE.brand.fill, barClass: HUE.brand.bar },
                  { label: "PJ", value: totalPj, fillClass: HUE.sky.fill, barClass: HUE.sky.bar },
                ]}
              />
              <LineChart
                xLabels={monthData.map((m) => m.label)}
                series={[
                  {
                    label: "PF",
                    points: monthData.map((m) => m.pf),
                    strokeClass: HUE.brand.stroke,
                    dotClass: HUE.brand.fill,
                    chipClass: HUE.brand.bar,
                  },
                  {
                    label: "PJ",
                    points: monthData.map((m) => m.pj),
                    strokeClass: HUE.sky.stroke,
                    dotClass: HUE.sky.fill,
                    chipClass: HUE.sky.bar,
                  },
                ]}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {revenue && (
      <Card>
        <CardHeader>
          <CardTitle>Histórico de faturamento</CardTitle>
          <CardDescription>Últimos {HISTORY_MONTHS} meses</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {history.map((h) => (
              <li key={h.key} className="grid grid-cols-[2.5rem_1fr_6.5rem] items-center gap-3 text-sm">
                <span className="text-muted-foreground">{h.label}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-accent">
                  {/* Amarelo não lê sobre branco: contorno âmbar escuro (--chart-3, 4:1) dá o limite da barra. */}
                  <span className="block h-full rounded-full border border-chart-3 bg-primary" style={{ width: `${(h.amount / historyMax) * 100}%` }} />
                </span>
                <span className="text-right font-bold tabular-nums">{formatCurrency(h.amount)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      )}
    </div>
  );
}
