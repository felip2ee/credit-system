import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ClientTimeline } from "@/components/clients/client-timeline";
import { AddOpportunityNote } from "@/components/opportunities/add-opportunity-note";
import { DocumentChecklist } from "@/components/opportunities/document-checklist";
import { FinancingScenarioCard } from "@/components/opportunities/financing-scenario-card";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";
import { RealEstateOrderForm } from "@/components/opportunities/real-estate-order-form";
import { OpportunityPipeline } from "@/components/opportunities/opportunity-pipeline";
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import {
  readScenario,
  REAL_ESTATE_PRODUCT_NAME,
} from "@/lib/checklists/real-estate";
import { readRealEstateOrder } from "@/lib/orders/real-estate-order";
import { formatCNPJ, formatCPF, formatCurrency } from "@/lib/utils";
import type {
  CreditProduct,
  CrmClient,
  Opportunity,
  OpportunityDocument,
  TimelineEvent,
} from "@/types/app";

export default async function OpportunityDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const { data: oppData } = await supabase
    .from("opportunities")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!oppData) notFound();
  const opportunity = oppData as Opportunity;

  const { data: clientData } = await supabase
    .from("crm_clients")
    .select("id, type, name, document")
    .eq("id", opportunity.crm_client_id)
    .maybeSingle();
  const client = clientData as Pick<
    CrmClient,
    "id" | "type" | "name" | "document"
  > | null;

  const { data: productData } = await supabase
    .from("credit_products")
    .select("id, name, type, description, is_active")
    .eq("is_active", true)
    .order("type", { ascending: true })
    .order("name", { ascending: true });
  const products = (productData ?? []) as CreditProduct[];

  const currentProductName =
    products.find((p) => p.id === opportunity.credit_product_id)?.name ?? null;
  const isRealEstate = currentProductName === REAL_ESTATE_PRODUCT_NAME;

  const { data: docsData } = await supabase
    .from("opportunity_documents")
    .select("*")
    .eq("opportunity_id", opportunity.id)
    .order("created_at", { ascending: true });
  const docs = (docsData ?? []) as OpportunityDocument[];

  const { data: eventsData } = await supabase
    .from("timeline_events")
    .select("*")
    .eq("entity_type", "opportunity")
    .eq("entity_id", opportunity.id)
    .order("created_at", { ascending: false });
  const events = (eventsData ?? []) as TimelineEvent[];

  const documentLabel = client?.document
    ? client.type === "PJ"
      ? formatCNPJ(client.document)
      : formatCPF(client.document)
    : "—";

  return (
    <div className="space-y-6">
      <PageHeader
        title={client?.name ?? "Oportunidade"}
        description={`${client?.type === "PJ" ? "Pessoa Jurídica" : "Pessoa Física"} · ${documentLabel}`}
      >
        <OpportunityStatusBadge status={opportunity.status} />
        {client && (
          <Button asChild variant="outline">
            <Link href={`/clients/${client.id}`}>Ver cliente</Link>
          </Button>
        )}
        {opportunity.query_id && (
          <Button asChild variant="outline">
            <Link href={`/consultations/${opportunity.query_id}`}>
              Ver consulta
            </Link>
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <OpportunityPipeline
            opportunityId={opportunity.id}
            status={opportunity.status}
          />
          {opportunity.status === "approved" &&
            opportunity.approved_amount != null && (
              <p className="mt-3 text-sm text-emerald-700">
                Valor aprovado: {formatCurrency(opportunity.approved_amount)}
              </p>
            )}
          {opportunity.status === "rejected" && opportunity.rejection_reason && (
            <p className="mt-3 text-sm text-destructive">
              Motivo da recusa: {opportunity.rejection_reason}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Detalhes do crédito</CardTitle>
            </CardHeader>
            <CardContent>
              <OpportunityForm
                opportunity={opportunity}
                products={products}
                entityKind={client?.type ?? "PJ"}
              />
            </CardContent>
          </Card>

          {isRealEstate && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Cenário do financiamento
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FinancingScenarioCard
                  opportunityId={opportunity.id}
                  initial={readScenario(opportunity.pf_extra_data)}
                />
              </CardContent>
            </Card>
          )}

          {isRealEstate && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Dados do financiamento imobiliário
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RealEstateOrderForm
                  opportunityId={opportunity.id}
                  initial={readRealEstateOrder(opportunity.pf_extra_data)}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Checklist de documentos</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentChecklist docs={docs} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <AddOpportunityNote opportunityId={opportunity.id} />
              <ClientTimeline events={events} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
