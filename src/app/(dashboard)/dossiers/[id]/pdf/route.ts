import { getRequiredSession } from "@/lib/auth/session";
import { getDossierPdfDetail } from "@/lib/dossiers/queries";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import {
  renderDossierPdf,
  type DossierEntry,
} from "@/lib/pdf/dossier-document";
import type { FullPdfHeader } from "@/lib/pdf/consultation-full-document";
import type { OpinionForPdf } from "@/lib/pdf/markdown-pdf";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!hasPermission(session, "consultations:read")) {
    return new Response("Sem permissão.", { status: 403 });
  }

  if (!isUuid(params.id)) return new Response("Pesquisa não encontrada.", { status: 404 });
  const detail = await getDossierPdfDetail(session, params.id);
  if (!detail) return new Response("Pesquisa não encontrada.", { status: 404 });
  const { dossier, members, report } = detail;

  // Empresa (PJ) primeiro, depois os sócios (PF) — mesma ordem da tela.
  const ordered = [...members].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "PJ" ? -1 : 1
  );
  if (ordered.length === 0) {
    return new Response("Nenhuma consulta concluída nesta pesquisa.", { status: 409 });
  }

  const entries: DossierEntry[] = [];
  for (const m of ordered) {
    const [payload, canonical] = await Promise.all([
      loadLatestPayload(session, m.id),
      loadCanonicalResult(session, m.id),
    ]);
    const content = toConsultationContent(payload, canonical);
    if (!content.full && !content.view) continue;

    const header: FullPdfHeader = {
      name: m.document_name ?? content.view?.subject.name ?? "—",
      cpf: m.type === "PJ" ? formatCNPJ(m.document) : formatCPF(m.document),
      docLabel: m.type === "PJ" ? "CNPJ" : "CPF",
      produto: m.product ?? (m.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
      data: new Date(m.consulted_at ?? m.created_at).toLocaleString("pt-BR"),
      consultante: "Reino do Crédito",
      usuario: session.userId,
      endereco: content.view?.subject.location ?? undefined,
    };
    entries.push({ content, header, role: m.type === "PJ" ? "Empresa" : dossier.kind === "PF" ? "Titular" : "Sócio" });
  }

  if (entries.length === 0) {
    return new Response("Consultas sem resultado disponível.", { status: 409 });
  }

  let opinion: OpinionForPdf | null = null;
  if (report && report.status === "completed") {
    opinion = {
      aptitude: report.aptitude_status,
      classificacao: report.full_report?.classificacao_perfil ?? null,
      resumo: report.full_report?.resumo_executivo ?? null,
      pontosFortes: [],
      pontosAtencao: [],
      planoAcao: [],
      modelo: report.model_used,
      relatorioMarkdown: report.report_markdown,
    };
  }

  const pdf = await renderDossierPdf(
    {
      title: dossier.holder_name,
      subtitle: `${dossier.kind === "PF" ? formatCPF(dossier.holder_document) : formatCNPJ(dossier.holder_document)} · ${entries.length} consulta(s)`,
      entries,
      report: opinion,
    },
    letterheadDataUri()
  );

  const filename = `pesquisa-${dossier.holder_document}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
