import { createClient } from "@/lib/supabase/server";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import {
  renderCompanyProcessPdf,
  type CompanyProcessEntry,
} from "@/lib/pdf/company-process-document";
import type { FullPdfHeader, PfMix } from "@/lib/pdf/consultation-full-document";
import type { OpinionForPdf } from "@/lib/pdf/markdown-pdf";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { formatCNPJ, formatCPF } from "@/lib/utils";
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

function addressOf(mix: PfMix): string | undefined {
  const emp = mix.empresa?.data;
  const cad = mix.pessoa?.data?.dadosCadastrais;
  const parts = emp
    ? [emp.endereco, emp.numero, emp.bairro, emp.municipio && emp.uf ? `${emp.municipio}/${emp.uf}` : undefined, emp.cep ? `CEP ${emp.cep}` : undefined]
    : cad
      ? [cad.endereco, cad.numero, cad.bairro, cad.cidade && cad.uf ? `${cad.cidade}/${cad.uf}` : undefined, cad.cep ? `CEP ${cad.cep}` : undefined]
      : [];
  const joined = parts.filter(Boolean).join(", ");
  return joined || undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

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
    const table = m.type === "PJ" ? "query_results_pj" : "query_results_pf";
    const { data: resultRow } = await supabase
      .from(table)
      .select("raw_response")
      .eq("query_id", m.id)
      .maybeSingle();

    const raw = (resultRow as { raw_response?: Record<string, unknown> } | null)?.raw_response;
    if (!raw || typeof raw !== "object") continue;

    const mix = raw as PfMix;
    const header: FullPdfHeader = {
      name: m.document_name ?? "—",
      cpf: m.type === "PJ" ? formatCNPJ(m.document) : formatCPF(m.document),
      docLabel: m.type === "PJ" ? "CNPJ" : "CPF",
      produto: m.product ?? (m.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
      data: new Date(m.consulted_at ?? m.created_at).toLocaleString("pt-BR"),
      consultante: (raw.consultante as string) ?? "Reino do Crédito",
      usuario: (raw.usuario as string) ?? "—",
      endereco: addressOf(mix),
    };
    entries.push({ mix, header, role: m.type === "PJ" ? "Empresa" : "Sócio" });
  }

  if (entries.length === 0) {
    return new Response("Consultas sem resultado disponível.", { status: 409 });
  }

  // Parecer consolidado — vai no final, em página própria.
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
