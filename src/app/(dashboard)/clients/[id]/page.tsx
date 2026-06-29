import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Pencil, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { AddNote } from "@/components/clients/add-note";
import { ClientStatusSelect } from "@/components/clients/client-status-select";
import {
  PartnerSection,
  type PartnerItem,
} from "@/components/clients/partner-section";
import { ClientTimeline } from "@/components/clients/client-timeline";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";
import type { CrmClient, QueryStatus, TimelineEvent } from "@/types/app";

interface RelationRow {
  client_id: string;
  related_id: string;
  percentage: number | null;
  role: string | null;
}

interface ClientConsultation {
  id: string;
  type: "PF" | "PJ";
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  consulted_at: string | null;
  created_at: string;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const { data: clientData } = await supabase
    .from("crm_clients")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!clientData) notFound();
  const client = clientData as CrmClient;

  // Relações de sociedade nos dois sentidos.
  const { data: relData } = await supabase
    .from("crm_client_relations")
    .select("client_id, related_id, percentage, role")
    .eq("relation_type", "socio")
    .or(`client_id.eq.${client.id},related_id.eq.${client.id}`);
  const relations = (relData ?? []) as RelationRow[];

  const socioRels = relations.filter((r) => r.client_id === client.id);
  const participationRels = relations.filter((r) => r.related_id === client.id);

  const referencedIds = Array.from(
    new Set([
      ...socioRels.map((r) => r.related_id),
      ...participationRels.map((r) => r.client_id),
    ])
  );

  const peopleMap = new Map<
    string,
    Pick<CrmClient, "id" | "name" | "document" | "type">
  >();
  if (referencedIds.length > 0) {
    const { data: people } = await supabase
      .from("crm_clients")
      .select("id, name, document, type")
      .in("id", referencedIds);
    for (const p of (people ?? []) as Pick<
      CrmClient,
      "id" | "name" | "document" | "type"
    >[]) {
      peopleMap.set(p.id, p);
    }
  }

  const partners: PartnerItem[] = socioRels.map((r) => {
    const person = peopleMap.get(r.related_id);
    return {
      id: r.related_id,
      name: person?.name ?? "—",
      document: person?.document ?? null,
      percentage: r.percentage,
      role: r.role,
    };
  });

  const participations = participationRels.map((r) => {
    const person = peopleMap.get(r.client_id);
    return {
      id: r.client_id,
      name: person?.name ?? "—",
      document: person?.document ?? null,
    };
  });

  const { data: eventsData } = await supabase
    .from("timeline_events")
    .select("*")
    .eq("entity_type", "crm_client")
    .eq("entity_id", client.id)
    .order("created_at", { ascending: false });
  const events = (eventsData ?? []) as TimelineEvent[];

  // Consultas deste cliente (mais recentes primeiro) — abrem direto na ficha.
  const { data: queriesData } = await supabase
    .from("queries")
    .select(
      "id, type, document, document_name, product, status, consulted_at, created_at"
    )
    .eq("crm_client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const consultations = (queriesData ?? []) as ClientConsultation[];

  const documentLabel = client.document
    ? client.type === "PJ"
      ? formatCNPJ(client.document)
      : formatCPF(client.document)
    : "—";

  const fullAddress = [
    client.address,
    client.address_number,
    client.neighborhood,
    client.city && client.state ? `${client.city}/${client.state}` : client.city,
    client.zip_code,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-6">
      <PageHeader
        title={client.name}
        description={`${client.type === "PJ" ? "Pessoa Jurídica" : "Pessoa Física"} · ${documentLabel}`}
      >
        <ClientStatusSelect clientId={client.id} status={client.status} />
        <Button asChild variant="outline">
          <Link href={`/clients/${client.id}/edit`}>
            <Pencil className="h-4 w-4" />
            Editar
          </Link>
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Dados cadastrais</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="E-mail" value={client.email} />
                <Field label="Telefone" value={client.phone} />
                <Field label="Endereço" value={fullAddress || null} />
                <Field label="Observações" value={client.notes} />
              </dl>
            </CardContent>
          </Card>

          {client.type === "PJ" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Sócios</CardTitle>
              </CardHeader>
              <CardContent>
                <PartnerSection pjClientId={client.id} partners={partners} />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Participações em empresas</CardTitle>
              </CardHeader>
              <CardContent>
                {participations.length > 0 ? (
                  <ul className="space-y-2">
                    {participations.map((p) => (
                      <li key={p.id} className="rounded-md border p-3 text-sm">
                        <Link
                          href={`/clients/${p.id}`}
                          className="font-medium hover:underline"
                        >
                          {p.name}
                        </Link>
                        {p.document && (
                          <span className="ml-2 text-muted-foreground">
                            {formatCNPJ(p.document)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nenhuma participação registrada.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-lg">
                Consultas {consultations.length > 0 && `(${consultations.length})`}
              </CardTitle>
              <Button asChild variant="outline" size="sm">
                <Link href="/consultations/new">
                  <Plus className="h-4 w-4" />
                  Nova consulta
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {consultations.length > 0 ? (
                <ul className="divide-y">
                  {consultations.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/consultations/${c.id}`}
                        className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {c.document_name ||
                              (c.type === "PJ"
                                ? formatCNPJ(c.document)
                                : formatCPF(c.document))}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {[c.product, formatDate(c.consulted_at ?? c.created_at)]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <QueryStatusBadge status={c.status} />
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nenhuma consulta para este cliente ainda.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <AddNote clientId={client.id} />
              <ClientTimeline events={events} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
