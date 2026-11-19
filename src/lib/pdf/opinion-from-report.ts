import type { OpinionForPdf } from "./markdown-pdf";

// Converte a linha de `ai_reports` (parecer de PF/PJ) no parecer do PDF.
// Só pareceres concluídos entram; qualquer outro estado vira null.
export function opinionFromAiReport(row: Record<string, unknown> | null): OpinionForPdf | null {
  if (!row || row.status !== "completed") return null;
  const full = row.full_report as { classificacao_perfil?: string } | null;
  // `numeric` chega do pg como string.
  const limit = row.suggested_limit == null ? null : Number(row.suggested_limit);
  return {
    aptitude: (row.aptitude_status as string | null) ?? null,
    classificacao: full?.classificacao_perfil ?? null,
    resumo: (row.executive_summary as string | null) ?? null,
    pontosFortes: (row.positive_points as OpinionForPdf["pontosFortes"] | null) ?? [],
    pontosAtencao: (row.risk_points as OpinionForPdf["pontosAtencao"] | null) ?? [],
    planoAcao: (row.action_plan as OpinionForPdf["planoAcao"] | null) ?? [],
    limiteSugerido: Number.isFinite(limit) ? limit : null,
    limiteNotas: (row.suggested_limit_notes as string | null) ?? null,
    modelo: (row.model_used as string | null) ?? null,
    relatorioMarkdown: (row.report_markdown as string | null) ?? null,
  };
}
