import Link from "next/link";
import {
  Bot,
  Layers,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";

// Limites de período no fuso de Brasília (UTC-3, sem horário de verão).
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

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

// Cores do pipeline por status (paleta já usada no projeto).
const PIPELINE_COLOR: Partial<Record<QueryStatus, string>> = {
  completed: "bg-emerald-500",
  pending_authorization: "bg-amber-500",
  processing: "bg-sky-500",
  error: "bg-red-500",
};
const PIPELINE_ORDER: QueryStatus[] = [
  "completed",
  "pending_authorization",
  "processing",
  "error",
];

export default async function DashboardPage() {
  const supabase = createClient();
  const { startToday, startMonth, start7d } = brBoundaries();

  const baseQueries = () =>
    supabase.from("queries").select("*", { count: "exact", head: true });

  const [
    hoje,
    semana,
    mes,
    scrPend,
    clientes,
    pareceres,
    processos,
    cCompleted,
    cPending,
    cProcessing,
    cError,
  ] = await Promise.all([
    baseQueries().gte("created_at", startToday),
    baseQueries().gte("created_at", start7d),
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
  ]);

  const n = (r: { count: number | null }) => r.count ?? 0;

  const primary = [
    { label: "Consultas hoje", value: n(hoje), hint: "Criadas hoje", href: "/consultations", icon: Search },
    { label: "Consultas (7 dias)", value: n(semana), hint: "Últimos 7 dias", href: "/consultations", icon: Search },
    { label: "Consultas no mês", value: n(mes), hint: "Mês corrente", href: "/consultations", icon: Search },
    { label: "Aguardando SCR", value: n(scrPend), hint: "Autorizações pendentes", href: "/scr", icon: ShieldCheck },
  ];

  const secondary = [
    { label: "Clientes", value: n(clientes), hint: "Cadastrados", href: "/clients", icon: Users },
    { label: "Pareceres de IA", value: n(pareceres), hint: "Gerados", href: "/consultations", icon: Bot },
    { label: "Processos em andamento", value: n(processos), hint: "Empresas em análise", href: "/batch", icon: Layers },
  ];

  const pipeline = {
    completed: n(cCompleted),
    pending_authorization: n(cPending),
    processing: n(cProcessing),
    error: n(cError),
  } as Record<QueryStatus, number>;
  const pipelineTotal = PIPELINE_ORDER.reduce((acc, s) => acc + pipeline[s], 0);

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

      {/* Pipeline de consultas por status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Consultas por status</CardTitle>
          <CardDescription>
            {pipelineTotal} {pipelineTotal === 1 ? "consulta" : "consultas"} no total
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pipelineTotal === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma consulta ainda.</p>
          ) : (
            PIPELINE_ORDER.map((status) => {
              const value = pipeline[status];
              const pct = Math.round((value / pipelineTotal) * 100);
              return (
                <div key={status} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{QUERY_STATUS_LABEL[status]}</span>
                    <span className="text-muted-foreground">
                      {value} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", PIPELINE_COLOR[status])}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
