import Link from "next/link";
import {
  Bot,
  Briefcase,
  Layers,
  Search,
  ShieldCheck,
  Users,
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
import { createClient } from "@/lib/supabase/server";
import { getCommissionRate } from "@/actions/settings";
import { getCurrentProfile } from "@/lib/auth";
import { formatCurrency } from "@/lib/utils";
import {
  OPPORTUNITY_STATUS_LABEL,
  QUERY_STATUS_LABEL,
  SCR_STATUS_LABEL,
  type EntityKind,
  type OpportunityStatus,
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

const OPP_HUE: Record<OpportunityStatus, Hue> = {
  new: "slate",
  documentation: "amber",
  analysis: "sky",
  sent_to_partner: "indigo",
  approved: "emerald",
  rejected: "red",
  completed: "emeraldDark",
  cancelled: "slateLight",
};
const OPP_ORDER: OpportunityStatus[] = [
  "new",
  "documentation",
  "analysis",
  "sent_to_partner",
  "approved",
  "completed",
  "rejected",
  "cancelled",
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

interface OppRow {
  status: OpportunityStatus;
  assigned_to: string | null;
  approved_amount: number | null;
  commission_rate: number | null;
  commission_amount: number | null;
}

function estCommission(o: OppRow, defaultRate: number): number {
  if (o.commission_amount != null) return o.commission_amount;
  const amount = o.approved_amount ?? 0;
  const rate = o.commission_rate ?? defaultRate;
  return (amount * rate) / 100;
}

interface ConsultantStat {
  id: string;
  name: string;
  approvedCount: number;
  approvedSum: number;
  commissionSum: number;
}

export default async function DashboardPage() {
  const supabase = createClient();
  const profile = await getCurrentProfile();
  const isAdmin = profile?.role === "admin";
  const commissionRate = await getCommissionRate();

  const { startToday, startMonth } = brBoundaries();
  const months = lastSixMonths();
  const start6mo = monthStartISO(months[0].year, months[0].month);

  const baseQueries = () =>
    supabase.from("queries").select("*", { count: "exact", head: true });

  const [
    hoje,
    mes,
    scrPend,
    clientes,
    pareceres,
    processos,
    cCompleted,
    cPending,
    cProcessing,
    cError,
    oppRes,
    scrRes,
    aiRes,
    queriesRes,
  ] = await Promise.all([
    baseQueries().gte("created_at", startToday),
    baseQueries().gte("created_at", startMonth),
    supabase
      .from("scr_authorizations")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase.from("crm_clients").select("*", { count: "exact", head: true }),
    supabase
      .from("ai_reports")
      .select("*", { count: "exact", head: true })
      .eq("status", "completed"),
    supabase
      .from("batches")
      .select("*", { count: "exact", head: true })
      .eq("status", "processing"),
    baseQueries().eq("status", "completed"),
    baseQueries().eq("status", "pending_authorization"),
    baseQueries().eq("status", "processing"),
    baseQueries().eq("status", "error"),
    supabase
      .from("opportunities")
      .select(
        "status, assigned_to, approved_amount, commission_rate, commission_amount"
      ),
    supabase.from("scr_authorizations").select("status"),
    supabase.from("ai_reports").select("aptitude_status"),
    supabase
      .from("queries")
      .select("created_at, type")
      .gte("created_at", start6mo),
  ]);

  const n = (r: { count: number | null }) => r.count ?? 0;

  // ── Oportunidades / conversão / comissões ──────────────────
  const oppRows = (oppRes.data ?? []) as OppRow[];
  const oppCounts = {} as Record<OpportunityStatus, number>;
  for (const s of OPP_ORDER) oppCounts[s] = 0;
  for (const r of oppRows) {
    if (r.status in oppCounts) oppCounts[r.status] += 1;
  }
  const oppTotal = oppRows.length;
  const won = oppCounts.approved + oppCounts.completed;
  const decided = won + oppCounts.rejected;
  const convRate = decided > 0 ? pct(won, decided) : null;

  // Estatísticas por consultor (somente aprovadas/concluídas com valor).
  const statByConsultant = new Map<string, ConsultantStat>();
  let totalApprovedSum = 0;
  let totalApprovedCount = 0;
  let totalCommission = 0;
  for (const o of oppRows) {
    const isWon = o.status === "approved" || o.status === "completed";
    if (!isWon || o.approved_amount == null || !o.assigned_to) continue;
    const commission = estCommission(o, commissionRate);
    totalApprovedSum += o.approved_amount;
    totalApprovedCount += 1;
    totalCommission += commission;
    const cur =
      statByConsultant.get(o.assigned_to) ??
      ({
        id: o.assigned_to,
        name: "—",
        approvedCount: 0,
        approvedSum: 0,
        commissionSum: 0,
      } as ConsultantStat);
    cur.approvedCount += 1;
    cur.approvedSum += o.approved_amount;
    cur.commissionSum += commission;
    statByConsultant.set(o.assigned_to, cur);
  }
  const ticketMedio =
    totalApprovedCount > 0 ? totalApprovedSum / totalApprovedCount : 0;

  // Nomes dos consultores (só admin lê profiles de terceiros via RLS).
  let consultants: ConsultantStat[] = [];
  if (isAdmin && statByConsultant.size > 0) {
    const ids = Array.from(statByConsultant.keys());
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", ids);
    const nameById = new Map(
      ((profs ?? []) as { id: string; full_name: string }[]).map((p) => [
        p.id,
        p.full_name,
      ])
    );
    consultants = Array.from(statByConsultant.values())
      .map((c) => ({ ...c, name: nameById.get(c.id) ?? "—" }))
      .sort((a, b) => b.approvedSum - a.approvedSum);
  }

  // ── Compliance SCR ─────────────────────────────────────────
  const scrRows = (scrRes.data ?? []) as { status: ScrStatus }[];
  const scrCounts = {} as Record<ScrStatus, number>;
  for (const s of SCR_ORDER) scrCounts[s] = 0;
  for (const r of scrRows) {
    if (r.status in scrCounts) scrCounts[r.status] += 1;
  }
  const scrTotal = scrRows.length;
  const scrCompliance = pct(scrCounts.authorized, scrTotal);

  // ── Aptidão dos pareceres ──────────────────────────────────
  const aiRows = (aiRes.data ?? []) as { aptitude_status: Aptitude | null }[];
  const aptCounts = {} as Record<Aptitude, number>;
  for (const a of APTITUDE_ORDER) aptCounts[a] = 0;
  for (const r of aiRows) {
    if (r.aptitude_status && r.aptitude_status in aptCounts)
      aptCounts[r.aptitude_status] += 1;
  }

  // ── Consultas por mês (PF/PJ) ──────────────────────────────
  const queryRows = (queriesRes.data ?? []) as {
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
    { label: "Consultas hoje", value: String(n(hoje)), hint: "Criadas hoje", href: "/consultations", icon: Search },
    { label: "Consultas no mês", value: String(n(mes)), hint: "Mês corrente", href: "/consultations", icon: Search },
    { label: "Taxa de conversão", value: convRate === null ? "—" : `${convRate}%`, hint: `${won} ganhas de ${decided} decididas`, href: "/opportunities", icon: Briefcase },
    { label: "Aguardando SCR", value: String(n(scrPend)), hint: "Autorizações pendentes", href: "/scr", icon: ShieldCheck },
  ];
  const secondary = [
    { label: "Clientes", value: String(n(clientes)), hint: "Cadastrados", href: "/clients", icon: Users },
    { label: "Pareceres de IA", value: String(n(pareceres)), hint: "Gerados", href: "/consultations", icon: Bot },
    { label: "Processos em andamento", value: String(n(processos)), hint: "Empresas em análise", href: "/batch", icon: Layers },
  ];

  const pipeline = {
    completed: n(cCompleted),
    pending_authorization: n(cPending),
    processing: n(cProcessing),
    error: n(cError),
  } as Record<QueryStatus, number>;
  const pipelineTotal = PIPELINE_ORDER.reduce((acc, s) => acc + pipeline[s], 0);

  const oppItems: CategoryItem[] = OPP_ORDER.map((s) => ({
    label: OPPORTUNITY_STATUS_LABEL[s],
    value: oppCounts[s],
    hue: OPP_HUE[s],
  }));
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
          <Link href="/batch/new">Novo processo</Link>
        </Button>
        <Button asChild>
          <Link href="/consultations/new">Nova consulta</Link>
        </Button>
      </PageHeader>

      {/* KPIs primários */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      {/* Desempenho de consultores — só admin */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Desempenho de consultores</CardTitle>
            <CardDescription>
              Aprovações, ticket médio e comissão bruta estimada (
              {commissionRate}% do aprovado quando não há taxa própria)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Total aprovado</p>
                <p className="text-2xl font-semibold">
                  {formatCurrency(totalApprovedSum)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {totalApprovedCount}{" "}
                  {totalApprovedCount === 1 ? "aprovação" : "aprovações"}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  Ticket médio de aprovação
                </p>
                <p className="text-2xl font-semibold">
                  {formatCurrency(ticketMedio)}
                </p>
                <p className="text-xs text-muted-foreground">por oportunidade ganha</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  Comissão bruta estimada
                </p>
                <p className="text-2xl font-semibold text-emerald-600">
                  {formatCurrency(totalCommission)}
                </p>
                <p className="text-xs text-muted-foreground">
                  ~{commissionRate}% do aprovado
                </p>
              </div>
            </div>

            {consultants.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">Consultor</th>
                      <th className="py-2 pr-3 text-right font-medium">Aprov.</th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Total aprovado
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Ticket médio
                      </th>
                      <th className="py-2 text-right font-medium">
                        Comissão est.
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {consultants.map((c, i) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 text-muted-foreground">
                          {i + 1}
                        </td>
                        <td className="py-2 pr-3 font-medium">{c.name}</td>
                        <td className="py-2 pr-3 text-right">
                          {c.approvedCount}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatCurrency(c.approvedSum)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatCurrency(c.approvedSum / c.approvedCount)}
                        </td>
                        <td className="py-2 text-right font-medium text-emerald-600">
                          {formatCurrency(c.commissionSum)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nenhuma aprovação com valor registrada ainda.
              </p>
            )}
          </CardContent>
        </Card>
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

      {/* Funil de oportunidades */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Funil de oportunidades</CardTitle>
          <CardDescription>
            {oppTotal} {oppTotal === 1 ? "oportunidade" : "oportunidades"} no total
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryCharts items={oppItems} emptyLabel="Nenhuma oportunidade ainda." />
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
