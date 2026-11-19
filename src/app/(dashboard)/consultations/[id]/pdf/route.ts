import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { getConsultation, getConsultationReport } from "@/lib/consultations/queries";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { config } from "@/lib/config";
import { getOwnBureauName } from "@/lib/bureaus/queries";
import { BRAND_NAME } from "@/lib/brand/brand";
import { renderCompleteConsultationPdf } from "@/lib/pdf/complete-consultation-document";
import { opinionFromAiReport } from "@/lib/pdf/opinion-from-report";
import type { FullPdfHeader } from "@/lib/pdf/consultation-full-document";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";
import type { QueryStatus } from "@/types/app";

// O nome do arquivo leva só o início do id: o documento do titular não vai para o disco do usuário.
const FILENAME_ID_LENGTH = 8;

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
  let session;
  try {
    session = await getRequiredSession();
  } catch {
    return new Response("Sessão expirada.", { status: 401 });
  }
  if (!hasPermission(session, "consultations:read")) return new Response("Não autorizado.", { status: 403 });
  if (!isUuid(params.id)) return new Response("Consulta não encontrada.", { status: 404 });
  const stored = await getConsultation(session, params.id);
  if (!stored) return new Response("Consulta não encontrada.", { status: 404 });
  if (stored.status !== "completed") return new Response("Consulta sem resultado disponível.", { status: 409 });
  const query: QueryRow = stored;

  const [payload, canonical] = await Promise.all([
    loadLatestPayload(session, params.id),
    loadCanonicalResult(session, params.id),
  ]);
  const content = toConsultationContent(payload, canonical);
  if (!content.full && !content.view) {
    // payload_incompatible, or a historical consultation not yet backfilled.
    return new Response(
      `Resultado não disponível no formato atual. Código da consulta: ${params.id}`,
      { status: 409 }
    );
  }

  const reportRow = await getConsultationReport(session, query.id);

  const opinion = opinionFromAiReport(reportRow);

  const header: FullPdfHeader = {
    name: query.document_name ?? content.view?.subject.name ?? "—",
    cpf: query.type === "PJ" ? formatCNPJ(query.document) : formatCPF(query.document),
    docLabel: query.type === "PJ" ? "CNPJ" : "CPF",
    produto: query.product ?? (query.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
    data: new Date(query.consulted_at ?? query.created_at).toLocaleString("pt-BR"),
    consultante: BRAND_NAME,
    usuario: session.userId,
    endereco: content.view?.subject.location ?? undefined,
  };

  const frame = { bureauName: (await getOwnBureauName(session)) ?? BRAND_NAME, supportEmail: config.supportEmail, issuedAt: new Date() };
  const pdf = await renderCompleteConsultationPdf(
    content,
    header,
    frame,
    opinion
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="consulta-${query.id.slice(0, FILENAME_ID_LENGTH)}.pdf"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
