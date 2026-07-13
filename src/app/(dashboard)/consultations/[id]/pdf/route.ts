import { createClient } from "@/lib/supabase/server";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import {
  renderConsultationPdf,
  type ConsultationPdfData,
} from "@/lib/pdf/consultation-document";
import {
  renderFullConsultationPdf,
  type PfMix,
  type FullPdfHeader,
  type OpinionForPdf,
} from "@/lib/pdf/consultation-full-document";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { countProtestos } from "@/lib/deps/protestos";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";
import type {
  AcoesJudiciaisData,
  PendenciasData,
  Socio,
  SmartClassificacao,
  SmartMetrica,
  SmartParecer,
} from "@/types/deps";

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

function buildData(query: QueryRow, row: Record<string, unknown>): ConsultationPdfData {
  const classificacao = row.smart_classificacao as SmartClassificacao | null;
  const parecer = row.smart_parecer as SmartParecer | null;
  const positivas = (row.smart_positivas as SmartMetrica[] | null) ?? [];
  const negativas = (row.smart_negativas as SmartMetrica[] | null) ?? [];

  const num = (k: string) => (row[k] as number | null) ?? null;

  let pendenciasTotal = 0;
  let pendenciasValor = 0;
  let acoes = 0;
  if (query.type === "PJ") {
    const pend = row.pendencias_data as PendenciasData | null;
    pendenciasTotal = pend?.total ?? 0;
    pendenciasValor = pend?.valorTotal ?? 0;
    acoes = (row.acoes_judiciais_data as AcoesJudiciaisData | null)?.total ?? 0;
  } else {
    pendenciasTotal = num("pendencias_total") ?? 0;
    pendenciasValor = num("pendencias_valor_total") ?? 0;
    acoes = num("acoes_judiciais_total") ?? 0;
  }
  const protestos = countProtestos(row.protestos_data);

  const data: ConsultationPdfData = {
    header: {
      name: query.document_name ?? "—",
      document:
        query.type === "PJ" ? formatCNPJ(query.document) : formatCPF(query.document),
      type: query.type,
      product: query.product ?? "Consulta",
      date: new Date(query.consulted_at ?? query.created_at).toLocaleString("pt-BR"),
      status: QUERY_STATUS_LABEL[query.status] ?? query.status,
    },
    score: {
      valor: num("score_valor"),
      risco: (row.score_risco as string | null) ?? null,
      descricao: (row.score_descricao as string | null) ?? null,
      prob: num("score_probabilidade_pagamento"),
    },
    smart: {
      classificacao: classificacao?.classificacao ?? null,
      aprovado: parecer?.aprovado ?? null,
      motivo: parecer?.motivo ?? null,
      limiteSugerido: classificacao?.limiteSugerido ?? null,
    },
    positivas: positivas.map((p) => ({ descricao: p.descricao, pontuacao: p.pontuacao })),
    negativas: negativas.map((n) => ({ descricao: n.descricao, pontuacao: n.pontuacao })),
    restricoes: {
      pendenciasTotal,
      pendenciasValor,
      protestos,
      acoes,
      chequesSemFundo: null,
    },
  };

  if (query.type === "PF") {
    data.pf = {
      rendaPresumida: num("renda_presumida_valor"),
      scrRiscoTotal: num("scr_risco_total"),
      scrCarteiraAtiva: num("scr_carteira_ativa"),
      scrLimiteCredito: num("scr_limite_credito"),
    };
  } else {
    const socios = (row.quadro_societario_socios as Socio[] | null) ?? [];
    data.pj = {
      situacao: (row.situacao_cadastral as string | null) ?? null,
      abertura: (row.data_inicio_atividade as string | null) ?? null,
      cnae: (row.cnae_principal as string | null) ?? null,
      capital: num("capital_social"),
      porte: (row.porte as string | null) ?? null,
      socios: socios.map((soc) => ({
        nome: soc.nome,
        participacao: soc.participacao ?? null,
        cargo: soc.cargoSociedade ?? null,
      })),
    };
  }

  return data;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const { data: queryData } = await supabase
    .from("queries")
    .select(
      "id, type, document, document_name, product, status, consulted_at, created_at"
    )
    .eq("id", params.id)
    .maybeSingle();

  if (!queryData) {
    return new Response("Consulta não encontrada.", { status: 404 });
  }
  const query = queryData as QueryRow;

  if (query.status !== "completed") {
    return new Response("Consulta sem resultado disponível.", { status: 409 });
  }

  const table = query.type === "PJ" ? "query_results_pj" : "query_results_pf";
  const { data: resultRow } = await supabase
    .from(table)
    .select("*")
    .eq("query_id", query.id)
    .maybeSingle();

  if (!resultRow) {
    return new Response("Resultado não encontrado.", { status: 404 });
  }

  const row = resultRow as Record<string, unknown>;
  const raw = row.raw_response as Record<string, unknown> | null;
  const isRichPf =
    query.type === "PF" &&
    raw != null &&
    typeof raw === "object" &&
    ("pessoa" in raw || "score" in raw);
  const isRichPj =
    query.type === "PJ" &&
    raw != null &&
    typeof raw === "object" &&
    ("empresa" in raw || "score" in raw);

  // Parecer de IA (ai_reports) — incluído ao final do PDF rico, se concluído.
  const { data: reportRow } = await supabase
    .from("ai_reports")
    .select(
      "status, aptitude_status, executive_summary, positive_points, risk_points, action_plan, suggested_limit, suggested_limit_notes, full_report, report_markdown, model_used"
    )
    .eq("query_id", query.id)
    .maybeSingle();

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

  let pdf: Buffer;
  if (isRichPf) {
    const mix = raw as PfMix;
    const header: FullPdfHeader = {
      name: query.document_name ?? "—",
      cpf: formatCPF(query.document),
      produto: query.product ?? DEPS_PRODUCT_PF,
      data: new Date(query.consulted_at ?? query.created_at).toLocaleString("pt-BR"),
      consultante: (raw.consultante as string) ?? "Reino do Crédito",
      usuario: (raw.usuario as string) ?? "—",
      endereco: mix.pessoa?.data?.dadosCadastrais
        ? [
            mix.pessoa.data.dadosCadastrais.endereco,
            mix.pessoa.data.dadosCadastrais.numero,
            mix.pessoa.data.dadosCadastrais.bairro,
            mix.pessoa.data.dadosCadastrais.cidade && mix.pessoa.data.dadosCadastrais.uf
              ? `${mix.pessoa.data.dadosCadastrais.cidade}/${mix.pessoa.data.dadosCadastrais.uf}`
              : undefined,
            mix.pessoa.data.dadosCadastrais.cep ? `CEP ${mix.pessoa.data.dadosCadastrais.cep}` : undefined,
          ]
            .filter(Boolean)
            .join(", ")
        : undefined,
    };
    pdf = await renderFullConsultationPdf(mix, header, letterheadDataUri(), opinion);
  } else if (isRichPj) {
    const mix = raw as PfMix;
    const emp = mix.empresa?.data;
    const header: FullPdfHeader = {
      name: query.document_name ?? "—",
      cpf: formatCNPJ(query.document),
      docLabel: "CNPJ",
      produto: query.product ?? DEPS_PRODUCT_PJ,
      data: new Date(query.consulted_at ?? query.created_at).toLocaleString("pt-BR"),
      consultante: (raw.consultante as string) ?? "Reino do Crédito",
      usuario: (raw.usuario as string) ?? "—",
      endereco: emp
        ? [
            emp.endereco,
            emp.numero,
            emp.bairro,
            emp.municipio && emp.uf ? `${emp.municipio}/${emp.uf}` : undefined,
            emp.cep ? `CEP ${emp.cep}` : undefined,
          ]
            .filter(Boolean)
            .join(", ")
        : undefined,
    };
    pdf = await renderFullConsultationPdf(mix, header, letterheadDataUri(), opinion);
  } else {
    const data = buildData(query, row);
    pdf = await renderConsultationPdf(data, letterheadDataUri(), opinion);
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="consulta-${query.document}.pdf"`,
      // Evita o navegador servir um PDF cacheado/desatualizado na mesma URL.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
