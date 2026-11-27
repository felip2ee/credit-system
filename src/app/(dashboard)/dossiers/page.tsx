import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Plus, Search } from "lucide-react";

import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import {
  AptitudeBadge,
  DOSSIER_KIND_LABEL,
  DossierStatusBadge,
} from "@/components/dossiers/dossier-badges";
import { dossierFilterParam, parseDossierFilter } from "@/components/dossiers/filters";
import { OrderStateBadge } from "@/components/dossiers/order-state-badge";
import { maskDocument } from "@/lib/mask-document";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedNav } from "@/components/ui/segmented-nav";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listDossiers, type DossierKindFilter } from "@/lib/dossiers/queries";
import { formatDate } from "@/lib/utils";

const TABS: { kind: DossierKindFilter | undefined; label: string }[] = [
  { kind: undefined, label: "Todos" },
  { kind: "PF", label: "PF" },
  { kind: "PJ_FULL", label: "PJ completo" },
];

function tabHref(kind: DossierKindFilter | undefined, q: string | undefined): string {
  const params = new URLSearchParams();
  const tipo = dossierFilterParam(kind);
  if (tipo) params.set("tipo", tipo);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/dossiers?${query}` : "/dossiers";
}

export default async function DossiersPage({
  searchParams,
}: {
  searchParams: { tipo?: string; q?: string };
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "consultations:read")) redirect("/");
  const kind = parseDossierFilter(searchParams.tipo);
  const dossiers = await listDossiers(session, { kind, q: searchParams.q });
  const canWrite = hasPermission(session, "consultations:write");

  return (
    <div className="space-y-6">
      <PageHeader title="Pesquisas" description="Dossiês de consulta por titular e quadro societário">
        {canWrite && (
          <>
            <Button asChild variant="cta">
              <Link href="/dossiers/new">
                <Plus className="h-4 w-4" />
                Novo pedido
              </Link>
            </Button>
          </>
        )}
      </PageHeader>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedNav
          label="Tipo de pesquisa"
          current="page"
          activeKey={kind ?? "all"}
          items={TABS.map((t) => ({ key: t.kind ?? "all", label: t.label, href: tabHref(t.kind, searchParams.q) }))}
        />
        <form action="/dossiers" className="flex gap-2 sm:w-96">
          {kind && <input type="hidden" name="tipo" value={dossierFilterParam(kind)} />}
          <SearchInput
            className="flex-1"
            name="q"
            aria-label="Buscar por nome, CPF ou CNPJ"
            placeholder="Buscar por nome, CPF ou CNPJ..."
            defaultValue={searchParams.q ?? ""}
          />
          <Button type="submit" variant="secondary" size="icon" aria-label="Buscar">
            <Search className="h-4 w-4" />
          </Button>
        </form>
      </div>

      <Card>
        <CardContent className="p-0">
          {dossiers.length === 0 ? (
            <p className="p-4 text-center text-base text-muted-foreground">Nenhuma pesquisa encontrada.</p>
          ) : (
            <ul className="divide-y">
              {dossiers.map((d) => (
                <li key={d.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 hover:bg-accent sm:items-center">
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-open:rotate-90 sm:mt-0" />
                      <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                        <p className="text-base font-bold [overflow-wrap:anywhere]">{d.holder_name}</p>
                        <p className="text-sm text-muted-foreground">
                          {DOSSIER_KIND_LABEL[d.kind]} · {d.members.length}{" "}
                          {d.members.length === 1 ? "consulta" : "consultas"} · {formatDate(d.created_at)}
                        </p>
                      </div>
                      <div className="flex max-w-full flex-wrap items-center gap-2 pl-7 sm:pl-0">
                        {d.kind === "PJ_FULL" && d.report_status === "completed" && (
                          <AptitudeBadge status={d.aptitude_status} />
                        )}
                        {d.order_state && <OrderStateBadge state={d.order_state} mode={d.order_mode ?? undefined} />}
                        <DossierStatusBadge status={d.status} />
                      </div>
                    </summary>
                    <div className="space-y-2 border-t bg-background/40 px-4 py-3 sm:pl-11">
                      <ul className="space-y-2">
                        {d.members.map((m) => (
                          <li key={m.id} className="grid grid-cols-1 gap-1 text-sm sm:flex sm:items-center sm:gap-3">
                            <span className="sm:w-24 sm:shrink-0 text-sm text-muted-foreground">
                              {m.type === "PJ" ? "Empresa" : d.kind === "PF" ? "Titular" : "Sócio"}
                            </span>
                            <Link href={`/consultations/${m.id}`} className="min-w-0 flex-1 truncate hover:underline">
                              {m.document_name ?? "—"}
                            </Link>
                            <span className="break-all font-mono sm:whitespace-nowrap text-sm text-muted-foreground">
                              {maskDocument(m.type, m.document)}
                            </span>
                            <span className="justify-self-start">
                              <QueryStatusBadge status={m.status} />
                            </span>
                          </li>
                        ))}
                      </ul>
                      <Link href={`/dossiers/${d.id}`} className="inline-flex min-h-11 items-center text-sm underline">
                        Abrir pesquisa
                      </Link>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
