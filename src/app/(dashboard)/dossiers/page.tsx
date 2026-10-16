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
import { maskDocument } from "@/components/dossiers/mask-document";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listDossiers, type DossierKindFilter } from "@/lib/dossiers/queries";
import { cn, formatDate } from "@/lib/utils";

const TABS: { kind: DossierKindFilter | undefined; label: string }[] = [
  { kind: undefined, label: "Todos" },
  { kind: "PF", label: "PF" },
  { kind: "PJ", label: "PJ" },
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
            <Button asChild>
              <Link href="/dossiers/new">
                <Plus className="h-4 w-4" />
                Novo pedido
              </Link>
            </Button>
          </>
        )}
      </PageHeader>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Tipo de pesquisa" className="flex gap-1 border-b">
          {TABS.map((t) => {
            const active = t.kind === kind;
            return (
              <Link
                key={t.label}
                href={tabHref(t.kind, searchParams.q)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "border-b-2 px-4 py-2 text-sm font-medium",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <form action="/dossiers" className="flex gap-2">
          {kind && <input type="hidden" name="tipo" value={dossierFilterParam(kind)} />}
          <Input
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
            <p className="p-6 text-center text-sm text-muted-foreground">Nenhuma pesquisa encontrada.</p>
          ) : (
            <ul className="divide-y">
              {dossiers.map((d) => (
                <li key={d.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-muted/50">
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{d.holder_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {DOSSIER_KIND_LABEL[d.kind]} · {d.members.length}{" "}
                          {d.members.length === 1 ? "consulta" : "consultas"} · {formatDate(d.created_at)}
                        </p>
                      </div>
                      {d.kind === "PJ_FULL" && d.report_status === "completed" && (
                        <AptitudeBadge status={d.aptitude_status} />
                      )}
                      {d.order_state && <OrderStateBadge state={d.order_state} />}
                      <DossierStatusBadge status={d.status} />
                    </summary>
                    <div className="space-y-2 border-t bg-muted/20 px-4 py-3 pl-11">
                      <ul className="space-y-2">
                        {d.members.map((m) => (
                          <li key={m.id} className="flex items-center gap-3 text-sm">
                            <span className="w-24 shrink-0 text-xs text-muted-foreground">
                              {m.type === "PJ" ? "Empresa" : d.kind === "PF" ? "Titular" : "Sócio"}
                            </span>
                            <Link href={`/consultations/${m.id}`} className="min-w-0 flex-1 truncate hover:underline">
                              {m.document_name ?? "—"}
                            </Link>
                            <span className="font-mono text-xs text-muted-foreground">
                              {maskDocument(m.type, m.document)}
                            </span>
                            <QueryStatusBadge status={m.status} />
                          </li>
                        ))}
                      </ul>
                      <Link href={`/dossiers/${d.id}`} className="inline-block text-sm underline">
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
