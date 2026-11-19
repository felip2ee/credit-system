import { getRequiredSession } from "@/lib/auth/session";
import { getDossierPdfDetail } from "@/lib/dossiers/queries";
import { getConsultationReport } from "@/lib/consultations/queries";
import { opinionFromAiReport } from "@/lib/pdf/opinion-from-report";
import { hasPermission } from "@/lib/db/permissions";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { config } from "@/lib/config";
import { getOwnBureauName } from "@/lib/bureaus/queries";
import { BRAND_NAME } from "@/lib/brand/brand";
import {
  renderDossierPdf,
  type DossierEntry,
} from "@/lib/pdf/dossier-document";
import type { FullPdfHeader } from "@/lib/pdf/consultation-full-document";
import type { OpinionForPdf } from "@/lib/pdf/markdown-pdf";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

// O nome do arquivo leva só o início do id: o documento do titular não vai para o disco do usuário.
const FILENAME_ID_LENGTH = 8;

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
      consultante: BRAND_NAME,
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
      pontosFortes: report.full_report?.pontos_fortes ?? [],
      pontosAtencao: report.full_report?.pontos_atencao ?? [],
      planoAcao: report.full_report?.plano_acao ?? [],
      limiteSugerido: report.full_report?.limite_sugerido ?? null,
      limiteNotas: report.full_report?.limite_sugerido_notas ?? null,
      modelo: report.model_used,
      relatorioMarkdown: report.report_markdown,
    };
  }

  // Sem parecer consolidado, vale o da consulta principal em ai_reports: o titular (PF), a empresa (PJ, PJ_FULL).
  // Num PJ_FULL sem a empresa concluída, o primeiro membro é um sócio e o parecer dele não descreve o grupo.
  const main = ordered[0];
  if (!opinion && (dossier.kind !== "PJ_FULL" || main.type === "PJ")) {
    opinion = opinionFromAiReport(await getConsultationReport(session, main.id));
  }

  const frame = { bureauName: (await getOwnBureauName(session)) ?? BRAND_NAME, supportEmail: config.supportEmail, issuedAt: new Date() };
  const pdf = await renderDossierPdf(
    {
      title: dossier.holder_name,
      subtitle: `${dossier.kind === "PF" ? formatCPF(dossier.holder_document) : formatCNPJ(dossier.holder_document)} · ${entries.length} consulta(s)`,
      entries,
      report: opinion,
    },
    frame
  );

  const filename = `pesquisa-${dossier.id.slice(0, FILENAME_ID_LENGTH)}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
