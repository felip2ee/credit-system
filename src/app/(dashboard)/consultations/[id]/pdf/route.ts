import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult } from "@/lib/consultations/canonical-store";
import { getConsultation, getConsultationReport } from "@/lib/consultations/queries";
import {
  toConsultationView,
  formatSubjectDocument,
} from "@/lib/consultations/view-model";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import {
  renderFullConsultationPdf,
  type FullPdfHeader,
  type OpinionForPdf,
} from "@/lib/pdf/consultation-full-document";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import type { QueryStatus } from "@/types/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface QueryRow {
  id: string;
  type: "PF" | "PJ";
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  consulted_at: string | null;
  created_at: string;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  let identity;
  try {
    const session = await getRequiredSession();
    identity = { userId: session.userId, role: session.role };
    if (!hasPermission(session.role, "consultations:read")) return new Response("Não autorizado.", { status: 403 });
  } catch {
    return new Response("Sessão expirada.", { status: 401 });
  }
  const stored = await getConsultation(identity, params.id);
  if (!stored) return new Response("Consulta não encontrada.", { status: 404 });
  if (stored.status !== "completed") return new Response("Consulta sem resultado disponível.", { status: 409 });
  const query: QueryRow = stored;

  const canonical = await loadCanonicalResult(identity, params.id);
  if (!canonical) {
    // payload_incompatible, or a historical consultation not yet backfilled.
    return new Response(
      `Resultado não disponível no formato atual. Código da consulta: ${params.id}`,
      { status: 409 }
    );
  }

  const view = toConsultationView(canonical);

  const reportRow = await getConsultationReport(identity, query.id);

  let opinion: OpinionForPdf | null = null;
  if (reportRow && (reportRow as { status?: string }).status === "completed") {
    const r = reportRow as Record<string, unknown>;
    const full = r.full_report as { classificacao_perfil?: string } | null;
    opinion = {
      aptitude: (r.aptitude_status as string | null) ?? null,
      classificacao: full?.classificacao_perfil ?? null,
      resumo: (r.executive_summary as string | null) ?? null,
      pontosFortes: (r.positive_points as OpinionForPdf["pontosFortes"] | null) ?? [],
      pontosAtencao: (r.risk_points as OpinionForPdf["pontosAtencao"] | null) ?? [],
      planoAcao: (r.action_plan as OpinionForPdf["planoAcao"] | null) ?? [],
      limiteSugerido: (r.suggested_limit as number | null) ?? null,
      limiteNotas: (r.suggested_limit_notes as string | null) ?? null,
      modelo: (r.model_used as string | null) ?? null,
      relatorioMarkdown: (r.report_markdown as string | null) ?? null,
    };
  }

  const header: FullPdfHeader = {
    name: query.document_name ?? (view.subject.name || "—"),
    cpf: formatSubjectDocument(canonical),
    docLabel: view.subject.documentLabel,
    produto:
      query.product ?? (view.kind === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
    data: new Date(query.consulted_at ?? query.created_at).toLocaleString("pt-BR"),
    consultante: "Reino do Crédito",
    usuario: identity.userId,
    endereco: view.subject.location ?? undefined,
  };

  const pdf = await renderFullConsultationPdf(
    view,
    header,
    letterheadDataUri(),
    opinion
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="consulta-${query.document}.pdf"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
