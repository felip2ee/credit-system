import { Eye, HandCoins, ShoppingBag, TrendingUp, UserPlus } from "lucide-react";
import { redirect } from "next/navigation";

import { Stat } from "@/components/dashboard/stat";
import { PageHeader } from "@/components/layout/page-header";
import { CopyLinkButton } from "@/components/superadmin/copy-link-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedNav } from "@/components/ui/segmented-nav";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { getBureauAdminMetrics } from "@/lib/bureau-admin/metrics";
import { config } from "@/lib/config";
import { parseRevenuePeriod, REVENUE_PERIODS } from "@/lib/dashboard/period";
import { formatCurrency } from "@/lib/utils";

export default async function AdminHomePage({ searchParams }: { searchParams: { periodo?: string | string[] } }) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!session.bureauId) redirect("/login");

  const period = parseRevenuePeriod(searchParams.periodo);
  const periodLabel = (REVENUE_PERIODS.find((p) => p.key === period)?.label ?? "").toLowerCase();
  const [bureau, metrics] = await Promise.all([
    getBureau(session, session.bureauId),
    getBureauAdminMetrics(session, period),
  ]);

  const base = config.betterAuthUrl.replace(/\/$/, "");
  const links = bureau
    ? [
        { title: "Link público do Bureau", hint: "Página de apresentação e entrada de clientes", url: `${base}/b/${bureau.slug}` },
        { title: "Link de cadastro", hint: "Cadastro direto de novos clientes e afiliados", url: `${base}/b/${bureau.slug}/cadastro` },
      ]
    : [];

  return (
    <div className="space-y-5">
      <PageHeader title="Início" description="Seus links e os números do Bureau" />

      <section aria-label="Links" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {links.map((l) => (
          <Card key={l.url}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{l.title}</CardTitle>
              <p className="text-sm text-muted-foreground">{l.hint}</p>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-2 hover:underline">
                {l.url}
              </a>
              <CopyLinkButton url={l.url} label={`Copiar ${l.title}`} />
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Resultados: {periodLabel}</h2>
        <SegmentedNav
          label="Período"
          activeKey={period}
          items={REVENUE_PERIODS.map((p) => ({ key: p.key, label: p.label, href: p.key === "mes" ? "/admin" : `/admin?periodo=${p.key}` }))}
        />
      </div>

      <section aria-label="Métricas" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Visitas" value={String(metrics.visits)} hint="Acessos ao link público" icon={Eye} />
        <Stat label="Cadastros" value={String(metrics.signups)} hint="Novos clientes" icon={UserPlus} />
        <Stat label="Vendas" value={String(metrics.sales)} hint="Pedidos pagos" icon={ShoppingBag} />
        {metrics.revenue !== null && (
          <Stat label="Faturamento" value={formatCurrency(metrics.revenue)} hint="Pedidos concluídos" icon={TrendingUp} />
        )}
        <Stat label="Afiliados" value={String(metrics.affiliates)} hint="Com código ativo" icon={HandCoins} />
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Top 5 afiliados</CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.ranking.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma venda de afiliado no período.</p>
          ) : (
            <ol className="divide-y divide-border">
              {metrics.ranking.map((r, i) => (
                <li key={`${i}-${r.name}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className="w-5 shrink-0 text-muted-foreground tabular-nums">{i + 1}</span>
                    <span className="truncate font-medium">{r.name}</span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {r.sales} {r.sales === 1 ? "venda" : "vendas"} · {formatCurrency(r.commission)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
