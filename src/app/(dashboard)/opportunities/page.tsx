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
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listOpportunities } from "@/lib/opportunities/queries";
import { redirect } from "next/navigation";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  OPPORTUNITY_STATUS_LABEL,
  type OpportunityStatus,
} from "@/types/app";

interface SearchParams {
  status?: string;
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session.role, "opportunities:read")) redirect("/");
  const activeStatus =
    searchParams.status && searchParams.status in OPPORTUNITY_STATUS_LABEL
      ? (searchParams.status as OpportunityStatus)
      : null;
  const opportunities = await listOpportunities(session, activeStatus);

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
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/opportunities/${o.id}`}
                        className="hover:underline"
                      >
                        {o.client_name}
                      </Link>
                    </TableCell>
                    <TableCell>{o.client_type}</TableCell>
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
