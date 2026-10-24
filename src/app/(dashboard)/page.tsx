import Link from "next/link";
import {
  Bot,
  HandCoins,
  Layers,
  Search,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import {
  CategoryCharts,
  type CategoryItem,
} from "@/components/reports/category-charts";
import { LineChart } from "@/components/reports/line-chart";
import { HUE, type Hue } from "@/components/reports/palette";
import { PieChart } from "@/components/reports/pie-chart";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { redirect } from "next/navigation";

import { getRequiredSession } from "@/lib/auth/session";
import { formatCurrency } from "@/lib/utils";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getDashboardMetrics } from "@/lib/dashboard/queries";
import { getPayableBalance } from "@/lib/payables/queries";
import { getWallet } from "@/lib/wallet/queries";
import {
  QUERY_STATUS_LABEL,
  SCR_STATUS_LABEL,
  type EntityKind,
  type QueryStatus,
  type ScrStatus,
} from "@/types/app";

// Limites de período no fuso de Brasília (UTC-3, sem horário de verão).
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTH_ABBR = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

function brBoundaries() {
  const now = Date.now();
  const br = new Date(now - BR_OFFSET_MS);
  const startToday = new Date(
    Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate()) + BR_OFFSET_MS
  ).toISOString();
  const startMonth = new Date(
    Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1) + BR_OFFSET_MS
  ).toISOString();
  const start7d = new Date(now - 7 * 86400000).toISOString();
  return { startToday, startMonth, start7d };
}

function lastSixMonths(): { year: number; month: number; label: string }[] {
  const br = new Date(Date.now() - BR_OFFSET_MS);
  const out: { year: number; month: number; label: string }[] = [];
  for (let i = 5; i >= 0; i--) {
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

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

// Hue de cada categoria para os gráficos (pizza + linha) do Dashboard.
const PIPELINE_HUE: Partial<Record<QueryStatus, Hue>> = {
  completed: "emerald",
  pending_authorization: "amber",
  processing: "sky",
  error: "red",
};
const PIPELINE_ORDER: QueryStatus[] = [
  "completed",
  "pending_authorization",
  "processing",
  "error",
];

const SCR_HUE: Record<ScrStatus, Hue> = {
  authorized: "emerald",
  pending: "amber",
  not_authorized: "red",
  expired: "slate",
};
const SCR_ORDER: ScrStatus[] = [
  "authorized",
  "pending",
  "not_authorized",
  "expired",
];

type Aptitude = "apt" | "apt_with_caveats" | "inapt" | "pending";
const APTITUDE_LABEL: Record<Aptitude, string> = {
  apt: "Apto",
  apt_with_caveats: "Apto com ressalvas",
  inapt: "Inapto",
  pending: "Pendente",
};
const APTITUDE_HUE: Record<Aptitude, Hue> = {
  apt: "emerald",
  apt_with_caveats: "amber",
  inapt: "red",
  pending: "slate",
};
const APTITUDE_ORDER: Aptitude[] = ["apt", "apt_with_caveats", "inapt", "pending"];

export default async function DashboardPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));

  const { startToday, startMonth } = brBoundaries();
  const months = lastSixMonths();
  const start6mo = monthStartISO(months[0].year, months[0].month);

  const metrics = await getDashboardMetrics(session, {
    startToday,
    startMonth,
    start6mo,
  });
  const { counts } = metrics;

  // Saldos do Bureau: carteira pré-paga (todos) e valor a receber (só quem vê repasses).
  const { bureauId } = session;
  const balances = bureauId
    ? await withUserTransaction(session, async (client) => ({
        wallet: await getWallet(client, bureauId),
        payable: hasPermission(session, "payout:read") ? await getPayableBalance(client, bureauId) : null,
      }))
    : null;

  // ── Compliance SCR ─────────────────────────────────────────
  const scrRows = metrics.scrStatuses.map((status) => ({
    status: status as ScrStatus,
  }));
  const scrCounts = {} as Record<ScrStatus, number>;
  for (const s of SCR_ORDER) scrCounts[s] = 0;
  for (const r of scrRows) {
    if (r.status in scrCounts) scrCounts[r.status] += 1;
  }
  const scrTotal = scrRows.length;
  const scrCompliance = pct(scrCounts.authorized, scrTotal);

  // ── Aptidão dos pareceres ──────────────────────────────────
  const aiRows = metrics.aptitudes.map((aptitude_status) => ({
    aptitude_status: aptitude_status as Aptitude | null,
  }));
  const aptCounts = {} as Record<Aptitude, number>;
  for (const a of APTITUDE_ORDER) aptCounts[a] = 0;
  for (const r of aiRows) {
    if (r.aptitude_status && r.aptitude_status in aptCounts)
      aptCounts[r.aptitude_status] += 1;
  }

  // ── Consultas por mês (PF/PJ) ──────────────────────────────
  const queryRows = metrics.monthlyQueries as {
    created_at: string;
    type: EntityKind;
  }[];
  const monthData = months.map((m) => ({ label: m.label, pf: 0, pj: 0 }));
  let totalPf = 0;
  let totalPj = 0;
  const indexByKey = new Map(months.map((m, i) => [`${m.year}-${m.month}`, i]));
  for (const r of queryRows) {
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

  // ── KPIs ───────────────────────────────────────────────────
  const primary = [
    { label: "Consultas hoje", value: String(counts.today), hint: "Criadas hoje", href: "/dossiers", icon: Search },
    { label: "Consultas no mês", value: String(counts.month), hint: "Mês corrente", href: "/dossiers", icon: Search },
    { label: "Aguardando SCR", value: String(counts.scrPending), hint: "Autorizações pendentes", href: "/scr", icon: ShieldCheck },
  ];
  const secondary = [
    { label: "Titulares", value: String(counts.holders), hint: "Cadastrados", href: "/holders", icon: Users },
    { label: "Pareceres de IA", value: String(counts.aiCompleted), hint: "Gerados", href: "/dossiers", icon: Bot },
    { label: "Pesquisas em andamento", value: String(counts.dossiersProcessing), hint: "Dossiês em análise", href: "/dossiers", icon: Layers },
  ];

  const balanceCards = balances
    ? [
        {
          label: "Saldo da carteira",
          value: formatCurrency(Number(balances.wallet?.available ?? 0)),
          hint: "Créditos pré-pagos disponíveis",
          href: "/settings/wallet",
          icon: Wallet,
        },
        ...(balances.payable === null
          ? []
          : [
              {
                label: "A receber",
                value: formatCurrency(Number(balances.payable)),
                hint: "Repasse pendente do Reino",
                href: "/settings/payouts",
                icon: HandCoins,
              },
            ]),
      ]
    : [];

  const pipeline = {
    completed: counts.cCompleted,
    pending_authorization: counts.cPending,
    processing: counts.cProcessing,
    error: counts.cError,
  } as Record<QueryStatus, number>;
  const pipelineTotal = PIPELINE_ORDER.reduce((acc, s) => acc + pipeline[s], 0);

  const scrItems: CategoryItem[] = SCR_ORDER.map((s) => ({
    label: SCR_STATUS_LABEL[s],
    value: scrCounts[s],
    hue: SCR_HUE[s],
  }));
  const aptItems: CategoryItem[] = APTITUDE_ORDER.map((a) => ({
    label: APTITUDE_LABEL[a],
    value: aptCounts[a],
    hue: APTITUDE_HUE[a],
  }));
  const pipelineItems: CategoryItem[] = PIPELINE_ORDER.map((s) => ({
    label: QUERY_STATUS_LABEL[s],
    value: pipeline[s],
    hue: PIPELINE_HUE[s] ?? "slate",
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Visão geral da operação de crédito">
        <Button asChild variant="outline">
          <Link href="/dossiers/new">PJ completo</Link>
        </Button>
        <Button asChild>
          <Link href="/consultations/new">Consulta PF/PJ</Link>
        </Button>
      </PageHeader>

      {/* KPIs primários */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {primary.map((m) => (
          <Link key={m.label} href={m.href}>
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>{m.label}</CardDescription>
                  <m.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-3xl">{m.value}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{m.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {balanceCards.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {balanceCards.map((m) => (
            <Link key={m.label} href={m.href}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardDescription>{m.label}</CardDescription>
                    <m.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardTitle className="text-2xl">{m.value}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">{m.hint}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* KPIs secundários */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {secondary.map((m) => (
          <Link key={m.label} href={m.href}>
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription>{m.label}</CardDescription>
                  <m.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-2xl">{m.value}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{m.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Consultas por mês — pizza (PF/PJ) + linha (6 meses) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Consultas por mês</CardTitle>
          <CardDescription>Últimos 6 meses, por tipo (PF/PJ)</CardDescription>
        </CardHeader>
        <CardContent>
          {totalPf + totalPj === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma consulta no período.
            </p>
          ) : (
            <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-2">
              <PieChart
                segments={[
                  { label: "PF", value: totalPf, fillClass: HUE.violet.fill, barClass: HUE.violet.bar },
                  { label: "PJ", value: totalPj, fillClass: HUE.sky.fill, barClass: HUE.sky.bar },
                ]}
              />
              <LineChart
                xLabels={monthData.map((m) => m.label)}
                series={[
                  {
                    label: "PF",
                    points: monthData.map((m) => m.pf),
                    strokeClass: HUE.violet.stroke,
                    dotClass: HUE.violet.fill,
                    chipClass: HUE.violet.bar,
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

      {/* Compliance SCR */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Compliance SCR</CardTitle>
          <CardDescription>
            {scrTotal > 0
              ? `${scrCompliance}% concedidas de ${scrTotal}`
              : "Autorizações por situação"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryCharts
            items={scrItems}
            emptyLabel="Nenhuma autorização registrada."
          />
        </CardContent>
      </Card>

      {/* Consultas por status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Consultas por status</CardTitle>
          <CardDescription>
            {pipelineTotal} {pipelineTotal === 1 ? "consulta" : "consultas"} no
            total
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryCharts
            items={pipelineItems}
            emptyLabel="Nenhuma consulta ainda."
          />
        </CardContent>
      </Card>

      {/* Pareceres de IA por aptidão */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pareceres de IA por aptidão</CardTitle>
          <CardDescription>Classificação dos pareceres gerados</CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryCharts
            items={aptItems}
            emptyLabel="Nenhum parecer gerado ainda."
          />
        </CardContent>
      </Card>
    </div>
  );
}
