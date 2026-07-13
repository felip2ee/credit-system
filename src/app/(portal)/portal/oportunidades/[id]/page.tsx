import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";

import { ClientTimeline } from "@/components/clients/client-timeline";
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge";
import { PortalDocumentChecklist } from "@/components/portal/portal-document-checklist";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency } from "@/lib/utils";
import {
  OPPORTUNITY_PIPELINE,
  OPPORTUNITY_STATUS_LABEL,
  type Opportunity,
  type OpportunityDocument,
  type OpportunityStatus,
  type TimelineEvent,
} from "@/types/app";

// Mensagem amigável por status, voltada ao cliente.
const STATUS_MESSAGE: Record<OpportunityStatus, string> = {
  new: "Recebemos sua solicitação e em breve daremos início.",
  documentation:
    "Precisamos dos seus documentos. Envie os itens pendentes abaixo.",
  analysis: "Seus documentos estão em análise pela nossa equipe.",
  sent_to_partner:
    "Sua solicitação foi enviada à instituição parceira. Aguarde o retorno.",
  approved: "Boa notícia! Sua solicitação foi aprovada.",
  rejected: "Sua solicitação não foi aprovada desta vez.",
  completed: "Processo concluído. Obrigado por confiar na Rainha do Crédito.",
  cancelled: "Esta solicitação foi cancelada.",
};

function ReadOnlyStepper({ status }: { status: OpportunityStatus }) {
  const currentIndex = OPPORTUNITY_PIPELINE.indexOf(status);
  // Estados terminais não fazem parte do stepper linear.
  const isTerminal = currentIndex === -1;
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {OPPORTUNITY_PIPELINE.map((step, i) => {
        const done = !isTerminal && currentIndex >= 0 && i < currentIndex;
        const active = step === status;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-emerald-500 bg-emerald-50 text-emerald-700",
                !active && !done && "text-muted-foreground"
              )}
            >
              {done && <Check className="h-3 w-3" />}
              {OPPORTUNITY_STATUS_LABEL[step]}
            </span>
            {i < OPPORTUNITY_PIPELINE.length - 1 && (
              <span className="h-px w-4 bg-border" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function PortalOpportunityPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  // RLS garante que o cliente só lê a própria oportunidade.
  const { data: oppData } = await supabase
    .from("opportunities")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!oppData) notFound();
  const opp = oppData as Opportunity;

  const { data: docsData } = await supabase
    .from("opportunity_documents")
    .select("*")
    .eq("opportunity_id", opp.id)
    .order("created_at", { ascending: true });
  const docs = (docsData ?? []) as OpportunityDocument[];

  const { data: eventsData } = await supabase
    .from("timeline_events")
    .select("*")
    .eq("entity_type", "opportunity")
    .eq("entity_id", opp.id)
    .order("created_at", { ascending: false });
  const events = (eventsData ?? []) as TimelineEvent[];

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/portal">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold">
            {opp.credit_purpose || "Solicitação de crédito"}
          </h1>
          <OpportunityStatusBadge status={opp.status} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Andamento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ReadOnlyStepper status={opp.status} />
          <p className="text-sm text-muted-foreground">
            {STATUS_MESSAGE[opp.status]}
          </p>
          {opp.status === "approved" && opp.approved_amount != null && (
            <p className="text-sm font-medium text-emerald-700">
              Valor aprovado: {formatCurrency(opp.approved_amount)}
            </p>
          )}
          {opp.status === "rejected" && opp.rejection_reason && (
            <p className="text-sm text-destructive">{opp.rejection_reason}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Detalhes</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Finalidade" value={opp.credit_purpose} />
            <Field
              label="Valor solicitado"
              value={
                opp.requested_amount != null
                  ? formatCurrency(opp.requested_amount)
                  : null
              }
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Documentos</CardTitle>
        </CardHeader>
        <CardContent>
          <PortalDocumentChecklist docs={docs} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Histórico</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientTimeline events={events} />
        </CardContent>
      </Card>
    </div>
  );
}
