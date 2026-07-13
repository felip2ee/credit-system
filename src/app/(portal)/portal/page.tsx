import Link from "next/link";
import { ChevronRight, FolderOpen } from "lucide-react";

import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { OpportunityStatus } from "@/types/app";

interface PortalOpportunity {
  id: string;
  status: OpportunityStatus;
  requested_amount: number | null;
  credit_purpose: string | null;
  created_at: string;
}

export default async function PortalHomePage() {
  const supabase = createClient();
  const profile = await getCurrentProfile();

  // crm_clients vinculados a este login (RLS já restringe ao próprio user_id).
  const { data: clientsData } = await supabase
    .from("crm_clients")
    .select("id")
    .order("created_at", { ascending: true });
  const clientIds = (clientsData ?? []).map((c) => (c as { id: string }).id);

  let opportunities: PortalOpportunity[] = [];
  if (clientIds.length > 0) {
    const { data: oppData } = await supabase
      .from("opportunities")
      .select("id, status, requested_amount, credit_purpose, created_at")
      .in("crm_client_id", clientIds)
      .order("created_at", { ascending: false });
    opportunities = (oppData ?? []) as PortalOpportunity[];
  }

  const firstName = profile?.full_name?.split(" ")[0] ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Olá{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          Acompanhe aqui suas solicitações de crédito e envie os documentos
          necessários.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Minhas solicitações</CardTitle>
        </CardHeader>
        <CardContent>
          {opportunities.length > 0 ? (
            <ul className="divide-y">
              {opportunities.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/portal/oportunidades/${o.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {o.credit_purpose || "Solicitação de crédito"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          o.requested_amount
                            ? formatCurrency(o.requested_amount)
                            : null,
                          formatDate(o.created_at),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <OpportunityStatusBadge status={o.status} />
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Você ainda não tem solicitações em andamento. Assim que abrirmos
                uma, ela aparece aqui.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
