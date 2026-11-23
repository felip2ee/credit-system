// Construção do payload de entrada do parecer de crédito + re-export dos system
// prompts (que vivem em ./prompts/). Referência: src/lib/ai/parecer-prompt.md
//
// Os prompts podem ser editados pelo admin (tabela `settings`); os textos de
// ./prompts/ são os defaults e a fonte da verdade.

import type { CanonicalBureauResult } from "@/types/bureau";

import { withBureau, type BureauInput, type CompanyBureaus } from "./bureau-input";
import { COMPANY_SYSTEM_PROMPT } from "./prompts/company";
import { SYSTEM_PROMPT_PF } from "./prompts/pf";
import { SYSTEM_PROMPT_PJ } from "./prompts/pj";

export { COMPANY_SYSTEM_PROMPT, SYSTEM_PROMPT_PF, SYSTEM_PROMPT_PJ };

// Alias de compatibilidade: fallback do generateParecer quando chamado sem
// systemPrompt explícito (na prática o prompt vem sempre de getAiPrompt).
export const SYSTEM_PROMPT = SYSTEM_PROMPT_PJ;

export const PROMPT_VERSION = "parecer-v3";

// Modelo OpenAI — configurável por env, com fallback seguro.
export const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";

// ─────────────────────────────────────────────────────────────────────────
// Payload de entrada: monta um objeto enxuto com os dados reais da consulta.
// Campos ausentes simplesmente não entram (a IA tratará como "Não informado").
// ─────────────────────────────────────────────────────────────────────────

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

function buildPjBureau(row: Record<string, unknown>): Record<string, unknown> {
  return compact({
    cadastro: compact({
      cnpj: row.cnpj,
      razaoSocial: row.razao_social,
      nomeFantasia: row.nome_fantasia,
      situacaoCadastral: row.situacao_cadastral,
      dataInicioAtividade: row.data_inicio_atividade,
      cnaePrincipal: row.cnae_principal,
      naturezaJuridica: row.natureza_juridica,
      capitalSocial: row.capital_social,
      porte: row.porte,
      municipio: row.municipio,
      uf: row.uf,
    }),
    score: compact({
      valor: row.score_valor,
      risco: row.score_risco,
      descricao: row.score_descricao,
      probabilidadePagamento: row.score_probabilidade_pagamento,
    }),
    smart: compact({
      classificacao: row.smart_classificacao,
      parecerBureau: row.smart_parecer,
      metricasPositivas: row.smart_positivas,
      metricasNegativas: row.smart_negativas,
    }),
    scr: row.scr_success ? row.scr_data : undefined,
    pendencias: row.pendencias_success ? row.pendencias_data : undefined,
    acoesJudiciais: row.acoes_judiciais_success ? row.acoes_judiciais_data : undefined,
    protestos: row.protestos_success ? row.protestos_data : undefined,
    quadroSocietario: row.quadro_societario_socios,
  });
}

function buildPfBureau(row: Record<string, unknown>): Record<string, unknown> {
  return compact({
    cadastro: compact({
      cpf: row.cpf,
      nome: row.nome,
      dataNascimento: row.data_nascimento,
      idade: row.idade,
      situacaoCadastral: row.situacao_cadastral,
      obito: row.obito,
      politicamenteExposta: row.politicamente_exposta,
      cidade: row.cidade,
      uf: row.uf,
    }),
    score: compact({
      valor: row.score_valor,
      risco: row.score_risco,
      descricao: row.score_descricao,
      probabilidadePagamento: row.score_probabilidade_pagamento,
    }),
    rendaPresumida: compact({
      descricao: row.renda_presumida_descricao,
      valor: row.renda_presumida_valor,
      valorMinimo: row.renda_presumida_valor_minimo,
      valorMaximo: row.renda_presumida_valor_maximo,
    }),
    smart: compact({
      classificacao: row.smart_classificacao,
      parecerBureau: row.smart_parecer,
      metricasPositivas: row.smart_positivas,
      metricasNegativas: row.smart_negativas,
    }),
    scr: row.scr_success
      ? compact({
          riscoTotal: row.scr_risco_total,
          carteiraAtiva: row.scr_carteira_ativa,
          limiteCredito: row.scr_limite_credito,
          aVencerTotal: row.scr_a_vencer_total,
          vencidoTotal: row.scr_vencido_total,
        })
      : undefined,
    pendencias: row.pendencias_success
      ? compact({
          total: row.pendencias_total,
          valorTotal: row.pendencias_valor_total,
          ocorrencias: row.pendencias_ocorrencias,
        })
      : undefined,
    acoesJudiciais: row.acoes_judiciais_success
      ? compact({
          total: row.acoes_judiciais_total,
          valorTotal: row.acoes_judiciais_valor_total,
          ocorrencias: row.acoes_judiciais_ocorrencias,
        })
      : undefined,
    protestos: row.protestos_success ? row.protestos_data : undefined,
    participacaoEmpresa: row.participacao_empresa_success
      ? row.participacao_empresa_data
      : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Allow-list do canônico (`dados_bureau`). O retorno bruto segue à parte, podado e
// com documentos mascarados, em `bureau` (src/lib/ai/bureau-input.ts).
// ─────────────────────────────────────────────────────────────────────────

function buildCanonicalBureau(c: CanonicalBureauResult): Record<string, unknown> {
  const s = c.subject;
  const debts = c.debts.items.filter((i) => i.source !== "acao_judicial");
  const lawsuits = c.debts.items.filter((i) => i.source === "acao_judicial");
  const centsToReais = (n: number | null) => (n == null ? undefined : n / 100);
  const occ = (i: (typeof c.debts.items)[number]) =>
    compact({
      credor: i.source,
      tipo: i.kind,
      valor: centsToReais(i.amountCents),
      data: i.date,
      cidade: i.city,
      uf: i.state,
    });

  return compact({
    cadastro: compact({
      tipo: s.kind,
      nome: s.name,
      nomeFantasia: s.tradeName,
      situacaoCadastral: s.registrationStatus,
      idade: s.age,
      obito: s.isDeceased,
      politicamenteExposta: s.isPoliticallyExposed,
      naturezaJuridica: s.legalNature,
      cnaePrincipal: s.mainActivity,
      porte: s.companySize,
      capitalSocial: centsToReais(s.capitalCents),
      dataInicioAtividade: s.startDate,
      cidade: s.city,
      uf: s.state,
    }),
    score: compact({
      valor: c.score.value,
      risco: c.score.riskBand,
      descricao: c.score.description,
      probabilidadePagamento: c.score.paymentProbability,
    }),
    pendencias: c.debts.items.length
      ? compact({
          total: debts.length,
          valorTotal: centsToReais(
            debts.reduce<number | null>(
              (a, i) => (i.amountCents == null ? a : (a ?? 0) + i.amountCents),
              null,
            ),
          ),
          ocorrencias: debts.length ? debts.map(occ) : undefined,
        })
      : undefined,
    acoesJudiciais: lawsuits.length
      ? { total: lawsuits.length, ocorrencias: lawsuits.map(occ) }
      : undefined,
    protestos: c.protests.total
      ? compact({
          total: c.protests.total,
          valorTotal: centsToReais(c.protests.amountCents),
          ocorrencias: c.protests.items.map((p) =>
            compact({ cartorio: p.registry, uf: p.state, data: p.date, valor: centsToReais(p.amountCents) }),
          ),
        })
      : undefined,
    cheques: compact({
      possuiInformacao: c.checks.hasInfo,
      devolvidosSemFundo: c.checks.returnedNoFunds,
      sustados: c.checks.stopped,
    }),
    consultasAnteriores: compact({
      ultimos30Dias: c.queries.last30Days,
      ultimos31a60Dias: c.queries.last31To60Days,
      ultimos61a90Dias: c.queries.last61To90Days,
      mais90Dias: c.queries.over90Days,
    }),
    quadroSocietario: c.companyOwnership.length
      ? c.companyOwnership.map((o) =>
          compact({ nome: o.name, participacao: o.sharePct, cargo: o.role }),
        )
      : undefined,
    participacaoEmpresas: c.participation.length
      ? c.participation.map((p) => compact({ nome: p.name, participacao: p.sharePct, cargo: p.role }))
      : undefined,
  });
}

export interface ParecerInput {
  type: "PF" | "PJ";
  dataAnalise: string; // ISO date
  canonical: CanonicalBureauResult;
  payload?: unknown;
}

export function buildUserPayload(input: ParecerInput, bureau?: BureauInput): string {
  const dados_bureau = buildCanonicalBureau(input.canonical);
  const base = { tipo_pessoa: input.type, data_analise: input.dataAnalise, dados_bureau };
  return JSON.stringify(bureau ? { ...base, bureau } : base, null, 2);
}

export const COMPANY_PROMPT_VERSION = "parecer-empresa-v4";

export interface CompanyParecerInput {
  dataAnalise: string; // ISO date
  empresaRow: Record<string, unknown>;
  empresaPayload?: unknown;
  socios: { type: "PF" | "PJ"; resultRow: Record<string, unknown>; payload?: unknown }[];
}

export function buildCompanyPayload(input: CompanyParecerInput, bureaus?: CompanyBureaus): string {
  const dados_empresa = withBureau(buildPjBureau(input.empresaRow), bureaus?.empresa);
  const dados_socios = input.socios.map((s, i) =>
    withBureau(s.type === "PJ" ? buildPjBureau(s.resultRow) : buildPfBureau(s.resultRow), bureaus?.socios[i])
  );

  return JSON.stringify(
    {
      tipo_pessoa: "PJ",
      data_analise: input.dataAnalise,
      dados_empresa,
      dados_socios,
    },
    null,
    2
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Prompts editáveis pelo admin (tabela `settings`). Estes são os DEFAULTS —
// se a chave correspondente não existir/estiver vazia, usa-se o texto daqui.
// PF e PJ partem do mesmo prompt adaptativo (que já trata os dois via
// tipo_pessoa) e podem ser customizados separadamente.
// ─────────────────────────────────────────────────────────────────────────

export type AiPromptKind = "pf" | "pj" | "empresa";

export const AI_PROMPT_KINDS: AiPromptKind[] = ["pf", "pj", "empresa"];

export const AI_PROMPT_LABEL: Record<AiPromptKind, string> = {
  pf: "Analisador PF",
  pj: "Analisador PJ",
  empresa: "Analisador de Empresa (quadro societário)",
};

export const DEFAULT_AI_PROMPTS: Record<AiPromptKind, string> = {
  pf: SYSTEM_PROMPT_PF,
  pj: SYSTEM_PROMPT_PJ,
  empresa: COMPANY_SYSTEM_PROMPT,
};

// Chave usada na tabela `settings` para cada prompt.
export const aiPromptKey = (kind: AiPromptKind) => `ai_prompt_${kind}`;
