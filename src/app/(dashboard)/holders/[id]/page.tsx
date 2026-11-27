import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pencil, Plus } from "lucide-react";

import {
  AptitudeBadge,
  DOSSIER_KIND_LABEL,
  DossierStatusBadge,
  isDossierKind,
} from "@/components/dossiers/dossier-badges";
import { AddNote } from "@/components/holders/add-note";
import { HolderTimeline } from "@/components/holders/holder-timeline";
import { LgpdActions } from "@/components/holders/lgpd-actions";
import { PartnerSection, type PartnerItem } from "@/components/holders/partner-section";
import { PortalAccessButton } from "@/components/holders/portal-access-button";
import { ClientBalanceCard } from "@/components/credits/ClientBalanceCard";
import { QueryStatusBadge } from "@/components/consultations/query-status-badge";
import { DetailHeader } from "@/components/dashboard/detail-header";
import { StackedRow } from "@/components/dashboard/stacked-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getHolderDetail } from "@/lib/holders/queries";
import { getClientAdjustmentLimits, listClientAdjustments } from "@/lib/wallet/client-adjustment";
import { getClientWallet, listClientLedger } from "@/lib/wallet/client-queries";
import { getWallet } from "@/lib/wallet/queries";
import { formatCNPJ, formatCPF, formatDate, formatDateSP } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";
import type { EntityKind, QueryStatus } from "@/types/app";

// Documento é nulo depois da anonimização (LGPD).
const formatDocument = (type: EntityKind, document: string | null) =>
  !document ? "—" : type === "PJ" ? formatCNPJ(document) : formatCPF(document);

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function HolderDetailPage({ params }: { params: { id: string } }) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "holders:read")) redirect("/");
  if (!isUuid(params.id)) notFound();
  const detail = await getHolderDetail(session, params.id);
  if (!detail) notFound();

  const { holder, companies, partners, consultations, dossiers, timeline, notes } = detail;
  const canWrite = hasPermission(session, "holders:write");
  const canInvite = hasPermission(session, "users:manage");
  const canManageLgpd = hasPermission(session, "lgpd:manage");
  const isAnonymized = holder.anonymized_at !== null;
  const canAdjust = hasPermission(session, "credits:adjust");
  const clientProfileId = holder.client_profile_id;
  const clientBalance =
    clientProfileId && hasPermission(session, "wallet:read")
      ? await withUserTransaction(session, async (client) => {
          const wallet = await getClientWallet(client, clientProfileId);
          const [ledger, adjustments, bureauWallet, limits] = await Promise.all([
            listClientLedger(client, clientProfileId),
            listClientAdjustments(client, clientProfileId),
            canAdjust && session.bureauId ? getWallet(client, session.bureauId) : null,
            canAdjust ? getClientAdjustmentLimits(client, clientProfileId) : null,
          ]);
          return {
            wallet: wallet ?? { available: "0.00", reserved: "0.00" },
            rows: ledger.rows,
            authors: Object.fromEntries(adjustments.map((a) => [a.id, a.authorName])),
            bureauAvailable: canAdjust ? (bureauWallet?.available ?? "0.00") : null,
            maxDebit: limits?.maxDebit ?? "0.00",
          };
        })
      : null;

  const partnerItems: PartnerItem[] = partners.map((p) => ({
    id: p.holder_id,
    name: p.name,
    type: p.type,
    document: p.document,
    percentage: p.percentage,
    role: p.role,
  }));

  const fullAddress = [
    holder.address,
    holder.address_number,
    holder.neighborhood,
    holder.city && holder.state ? `${holder.city}/${holder.state}` : holder.city,
    holder.zip_code,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-4">
      <DetailHeader title="Titular" backHref="/holders" backLabel="Voltar para Titulares" />

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="break-words text-xl font-bold">{holder.name}</h2>
          <p className="break-words text-sm text-muted-foreground">
            {holder.type === "PJ" ? "Pessoa Jurídica" : "Pessoa Física"} · {formatDocument(holder.type, holder.document)}
          </p>
        </div>
        {isAnonymized && <Badge variant="muted">Anonimizado em {formatDateSP(holder.anonymized_at)}</Badge>}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {canInvite && !isAnonymized && (
            <PortalAccessButton
              holderId={holder.id}
              hasAccess={Boolean(holder.client_profile_id)}
              hasEmail={Boolean(holder.email)}
            />
          )}
          {canWrite && !isAnonymized && (
            <Button asChild variant="outline">
              <Link href={`/holders/${holder.id}/edit`}>
                <Pencil className="h-4 w-4" />
                Editar
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Dados cadastrais</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="E-mail" value={holder.email} />
                <Field label="Telefone" value={holder.phone} />
                <Field label="Endereço" value={fullAddress || null} />
                <Field label="Observações" value={holder.notes} />
              </dl>
            </CardContent>
          </Card>

          {holder.type === "PJ" ? (
            <Card>
              <CardHeader>
                <CardTitle>Sócios</CardTitle>
              </CardHeader>
              <CardContent>
                {canWrite ? (
                  <PartnerSection companyId={holder.id} partners={partnerItems} />
                ) : partnerItems.length > 0 ? (
                  <ul className="space-y-2">
                    {partnerItems.map((p) => (
                      <li key={p.id} className="rounded-md border p-3 text-sm">
                        <Link href={`/holders/${p.id}`} className="font-medium hover:underline">
                          {p.name}
                        </Link>
                        <span className="ml-2 text-muted-foreground">
                          {p.role ? ` ${p.role}` : ""}
                          {p.percentage != null ? ` · ${p.percentage}%` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhum sócio vinculado.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Empresas em que é sócio</CardTitle>
              </CardHeader>
              <CardContent>
                {companies.length > 0 ? (
                  <ul className="space-y-2">
                    {companies.map((c) => (
                      <li key={c.holder_id} className="rounded-md border p-3 text-sm">
                        <Link href={`/holders/${c.holder_id}`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        <span className="ml-2 text-muted-foreground">
                          {formatDocument("PJ", c.document)}
                          {c.role ? ` · ${c.role}` : ""}
                          {c.percentage != null ? ` · ${c.percentage}%` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhuma empresa registrada.</p>
                )}
              </CardContent>
            </Card>
          )}

          {clientBalance && <ClientBalanceCard holderId={holder.id} {...clientBalance} />}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>
                Pesquisas {dossiers.length > 0 && `(${dossiers.length})`}
              </CardTitle>
              {hasPermission(session, "consultations:write") && !isAnonymized && (
                <Button asChild variant="outline" size="sm">
                  <Link href="/consultations/new">
                    <Plus className="h-4 w-4" />
                    Nova consulta
                  </Link>
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {dossiers.length > 0 ? (
                <ul className="-mx-4 divide-y divide-border">
                  {dossiers.map((d) => (
                    <StackedRow
                      key={d.id}
                      href={`/dossiers/${d.id}`}
                      title={isDossierKind(d.kind) ? DOSSIER_KIND_LABEL[d.kind] : d.kind}
                      meta={formatDate(d.created_at)}
                      status={
                        <>
                          {d.kind === "PJ_FULL" && d.report_status === "completed" && (
                            <AptitudeBadge status={d.aptitude_status} />
                          )}
                          <DossierStatusBadge status={d.status} />
                        </>
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhuma pesquisa para este titular ainda.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                Consultas {consultations.length > 0 && `(${consultations.length})`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {consultations.length > 0 ? (
                <ul className="-mx-4 divide-y divide-border">
                  {consultations.map((c) => (
                    <StackedRow
                      key={c.id}
                      href={`/consultations/${c.id}`}
                      title={c.document_name || formatDocument(c.type, c.document)}
                      meta={[c.product, formatDate(c.consulted_at ?? c.created_at)].filter(Boolean).join(" · ")}
                      status={<QueryStatusBadge status={c.status as QueryStatus} />}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhuma consulta para este titular ainda.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {canManageLgpd && (
            <LgpdActions holderId={holder.id} clientProfileId={holder.client_profile_id} anonymized={isAnonymized} />
          )}
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {canWrite && <AddNote holderId={holder.id} />}
              {notes.length > 0 && (
                <ul className="space-y-2">
                  {notes.map((n) => (
                    <li key={n.id} className="rounded-md border p-3 text-sm">
                      <p className="whitespace-pre-wrap">{n.content}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{formatDate(n.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <HolderTimeline events={timeline} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
