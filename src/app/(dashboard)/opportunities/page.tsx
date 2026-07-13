import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  OPPORTUNITY_STATUS_LABEL,
  type CrmClient,
  type Opportunity,
  type OpportunityStatus,
} from "@/types/app";

interface SearchParams {
  status?: string;
}

type OppRow = Pick<
  Opportunity,
  | "id"
  | "crm_client_id"
  | "status"
  | "requested_amount"
  | "partner_name"
  | "updated_at"
>;

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createClient();

  let query = supabase
    .from("opportunities")
    .select(
      "id, crm_client_id, status, requested_amount, partner_name, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(100);

  const activeStatus =
    searchParams.status && searchParams.status in OPPORTUNITY_STATUS_LABEL
      ? (searchParams.status as OpportunityStatus)
      : null;
  if (activeStatus) query = query.eq("status", activeStatus);

  const { data } = await query;
  const opportunities = (data ?? []) as OppRow[];

  // Resolve nomes dos clientes em uma segunda consulta (evita join aninhado).
  const clientIds = Array.from(
    new Set(opportunities.map((o) => o.crm_client_id))
  );
  const clientMap = new Map<string, Pick<CrmClient, "name" | "type">>();
  if (clientIds.length > 0) {
    const { data: people } = await supabase
      .from("crm_clients")
      .select("id, name, type")
      .in("id", clientIds);
    for (const p of (people ?? []) as Pick<
      CrmClient,
      "id" | "name" | "type"
    >[]) {
      clientMap.set(p.id, { name: p.name, type: p.type });
    }
  }

  const filters: { value: OpportunityStatus | "all"; label: string }[] = [
    { value: "all", label: "Todas" },
    ...(Object.entries(OPPORTUNITY_STATUS_LABEL) as [
      OpportunityStatus,
      string,
    ][]).map(([value, label]) => ({ value, label })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Oportunidades"
        description="Pipeline de intermediação de crédito"
      />

      <div className="flex flex-wrap gap-2">
        {filters.map((f) => {
          const active =
            f.value === "all" ? !activeStatus : activeStatus === f.value;
          const href =
            f.value === "all" ? "/opportunities" : `/opportunities?status=${f.value}`;
          return (
            <Link
              key={f.value}
              href={href}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Valor solicitado</TableHead>
                <TableHead>Parceiro</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Atualizada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {opportunities.map((o) => {
                const client = clientMap.get(o.crm_client_id);
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/opportunities/${o.id}`}
                        className="hover:underline"
                      >
                        {client?.name ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell>{client?.type ?? "—"}</TableCell>
                    <TableCell>{formatCurrency(o.requested_amount)}</TableCell>
                    <TableCell>{o.partner_name ?? "—"}</TableCell>
                    <TableCell>
                      <OpportunityStatusBadge status={o.status} />
                    </TableCell>
                    <TableCell>{formatDate(o.updated_at)}</TableCell>
                  </TableRow>
                );
              })}
              {opportunities.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    Nenhuma oportunidade encontrada.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
