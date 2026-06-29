import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Parecer de crédito gerado pela IA (OpenAI).
// O schema Zod valida em runtime a resposta JSON do modelo — se vier fora do
// formato, a geração falha de forma controlada em vez de salvar lixo.
// ─────────────────────────────────────────────────────────────────────────

// Aptidão no formato do banco (coluna ai_reports.aptitude_status):
// apt | apt_with_caveats | inapt
export type AptitudeStatus = "apt" | "apt_with_caveats" | "inapt";

export const PerfilClassificacao = z.enum([
  "Excelente",
  "Muito Bom",
  "Bom",
  "Regular",
  "Atenção",
  "Alto Risco",
]);

const PontoSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const RiscoSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: z.enum(["baixa", "média", "alta"]).default("média"),
});

const AcaoSchema = z.object({
  step: z.string(),
  description: z.string(),
  priority: z.enum(["imediata", "curto", "médio", "longo"]).default("curto"),
});

const ProdutoSugeridoSchema = z.object({
  product_name: z.string(),
  justification: z.string(),
});

const OportunidadeSchema = z.object({
  linha: z.string(),
  instituicao_sugerida: z.string().default("Não informado"),
  probabilidade_aprovacao_estimada: z.enum(["alta", "média", "baixa"]).default("média"),
  limite_potencial: z.string().default("Não informado"),
  observacao: z.string().default(""),
});

const NotasSchema = z.object({
  cadastro: z.number().min(0).max(10),
  score: z.number().min(0).max(10),
  scr: z.number().min(0).max(10),
  relacionamento_bancario: z.number().min(0).max(10),
  capacidade_financeira: z.number().min(0).max(10),
  garantias: z.number().min(0).max(10),
  risco: z.number().min(0).max(10),
  potencial_aprovacao: z.number().min(0).max(10),
  final: z.number().min(0).max(10),
});

// Schema principal devolvido pelo modelo.
export const ParecerSchema = z.object({
  tipo_pessoa: z.enum(["PF", "PJ"]),
  classificacao_perfil: PerfilClassificacao,
  // aptidão em pt-br do prompt → normalizada para AptitudeStatus no opinion.ts
  apto: z.enum(["apto", "apto_com_ressalvas", "inapto"]),
  resumo_executivo: z.string(),
  notas: NotasSchema,
  fatores_decisivos: z.object({
    maior_positivo: z.string(),
    maior_negativo: z.string(),
    prioritario_intervencao: z.string(),
  }),
  pontos_fortes: z.array(PontoSchema).default([]),
  pontos_atencao: z.array(RiscoSchema).default([]),
  plano_acao: z.array(AcaoSchema).default([]),
  produtos_sugeridos: z.array(ProdutoSugeridoSchema).default([]),
  top_oportunidades_imediatas: z.array(OportunidadeSchema).default([]),
  limite_sugerido: z.number().nullable().default(null),
  limite_sugerido_notas: z.string().default(""),
  dados_faltantes: z.array(z.string()).default([]),
  relatorio_markdown: z.string(),
  disclaimer: z.string(),
});

export type Parecer = z.infer<typeof ParecerSchema>;

// Mapeia a aptidão em pt-br do parecer para o enum do banco.
export function toAptitudeStatus(apto: Parecer["apto"]): AptitudeStatus {
  switch (apto) {
    case "apto":
      return "apt";
    case "apto_com_ressalvas":
      return "apt_with_caveats";
    case "inapto":
      return "inapt";
  }
}
