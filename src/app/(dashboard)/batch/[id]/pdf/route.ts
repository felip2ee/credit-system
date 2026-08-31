import { createClient } from "@/lib/supabase/server";
import { getRequiredSession } from "@/lib/auth/session";
import { loadCanonicalResult } from "@/lib/consultations/canonical-store";
import {
  toConsultationView,
  formatSubjectDocument,
} from "@/lib/consultations/view-model";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import {
  renderCompanyProcessPdf,
  type CompanyProcessEntry,
} from "@/lib/pdf/company-process-document";
import type { FullPdfHeader } from "@/lib/pdf/consultation-full-document";
import type { OpinionForPdf } from "@/lib/pdf/markdown-pdf";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { formatCNPJ } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MemberRow {
  id: string;
  type: EntityKind;
  document: string;
  document_name: string | null;
  product: string | null;
  consulted_at: string | null;
  created_at: string;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  let identity;
  try {
    const session = await getRequiredSession();
    identity = { userId: session.userId, role: session.role };
  } catch {
    return new Response("Sessão expirada.", { status: 401 });
  }

  const { data: batchData } = await supabase
    .from("batches")
    .select("id, document, name")
    .eq("id", params.id)
    .maybeSingle();
  if (!batchData) return new Response("Processo não encontrado.", { status: 404 });
  const batch = batchData as { id: string; document: string | null; name: string | null };

  const { data: membersData } = await supabase
    .from("queries")
    .select("id, type, document, document_name, product, consulted_at, created_at")
    .eq("batch_id", params.id)
    .eq("status", "completed")
    .order("created_at", { ascending: true });
  const members = (membersData ?? []) as MemberRow[];

  // Empresa (PJ) primeiro, depois os sócios (PF) — mesma ordem da tela.
  const ordered = [...members].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "PJ" ? -1 : 1
  );
  if (ordered.length === 0) {
    return new Response("Nenhuma consulta concluída neste processo.", { status: 409 });
  }

  const entries: CompanyProcessEntry[] = [];
  for (const m of ordered) {
    const canonical = await loadCanonicalResult(identity, m.id);
    if (!canonical) continue;

    const view = toConsultationView(canonical);
    const header: FullPdfHeader = {
      name: m.document_name ?? (view.subject.name || "—"),
      cpf: formatSubjectDocument(canonical),
      docLabel: view.subject.documentLabel,
      produto: m.product ?? (m.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
      data: new Date(m.consulted_at ?? m.created_at).toLocaleString("pt-BR"),
      consultante: "Reino do Crédito",
      usuario: identity.userId,
      endereco: view.subject.location ?? undefined,
    };
    entries.push({ view, header, role: m.type === "PJ" ? "Empresa" : "Sócio" });
  }

  if (entries.length === 0) {
    return new Response("Consultas sem resultado disponível.", { status: 409 });
  }

  // Parecer consolidado — vai no final, em página própria. (Supabase — Tasks 9/11.)
  const { data: reportRow } = await supabase
    .from("company_reports")
    .select("status, aptitude_status, report_markdown, full_report, model_used")
    .eq("batch_id", params.id)
    .maybeSingle();

  let report: OpinionForPdf | null = null;
  const r = reportRow as Record<string, unknown> | null;
  if (r && r.status === "completed") {
    const full = r.full_report as
      | { classificacao_perfil?: string; resumo_executivo?: string }
      | null;
    report = {
      aptitude: (r.aptitude_status as string | null) ?? null,
      classificacao: full?.classificacao_perfil ?? null,
      resumo: full?.resumo_executivo ?? null,
      pontosFortes: [],
      pontosAtencao: [],
      planoAcao: [],
      modelo: (r.model_used as string | null) ?? null,
      relatorioMarkdown: (r.report_markdown as string | null) ?? null,
    };
  }

  const pdf = await renderCompanyProcessPdf(
    {
      title: batch.name ?? "Processo de empresa",
      subtitle: `${batch.document ? formatCNPJ(batch.document) : "CNPJ não informado"} · ${entries.length} consulta(s)`,
      entries,
      report,
    },
    letterheadDataUri()
  );

  const filename = `processo-${batch.document ?? batch.id}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
