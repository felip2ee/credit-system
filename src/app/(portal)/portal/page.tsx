import Link from "next/link";
import { ChevronRight, FolderOpen } from "lucide-react";

import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listPortalOpportunities } from "@/lib/portal/queries";
import { formatCurrency, formatDate } from "@/lib/utils";

export default async function PortalHomePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session.role, "portal:read")) return null;
  const [profile, opportunities] = await Promise.all([
    getCurrentProfile(),
    listPortalOpportunities(session),
  ]);
  const firstName = profile?.full_name.split(" ")[0] ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Olá{firstName ? `, ${firstName}` : ""}</h1>
        <p className="text-sm text-muted-foreground">
          Acompanhe aqui suas solicitações de crédito e envie os documentos necessários.
        </p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-lg">Minhas solicitações</CardTitle></CardHeader>
        <CardContent>
          {opportunities.length > 0 ? (
            <ul className="divide-y">
              {opportunities.map((opportunity) => (
                <li key={opportunity.id}>
                  <Link href={`/portal/oportunidades/${opportunity.id}`} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{opportunity.credit_purpose || "Solicitação de crédito"}</p>
                      <p className="text-xs text-muted-foreground">
                        {[opportunity.requested_amount ? formatCurrency(opportunity.requested_amount) : null, formatDate(opportunity.created_at)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <OpportunityStatusBadge status={opportunity.status} />
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Você ainda não tem solicitações em andamento. Assim que abrirmos uma, ela aparece aqui.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
