import type {
  DepsConsultResultPF,
  DepsConsultResultPJ,
} from "@/types/deps";
import type { Database, Json } from "@/types/supabase";

type PjInsert = Database["public"]["Tables"]["query_results_pj"]["Insert"];
type PfInsert = Database["public"]["Tables"]["query_results_pf"]["Insert"];

// jsonb: os objetos da deps são serializáveis; o cast satisfaz o tipo Json.
const json = (v: unknown): Json => v as Json;

// Nome de exibição da consulta a partir do resultado do bureau:
// PF → nome completo (pessoa); PJ → razão social (empresa). Null se ausente.
export function resultDisplayName(
  type: "PF" | "PJ",
  r: DepsConsultResultPF | DepsConsultResultPJ
): string | null {
  const mix = r.mix as unknown as Record<string, { data?: Record<string, unknown> | null }>;
  const value =
    type === "PJ"
      ? (mix.empresa?.data?.razaoSocial as string | undefined)
      : (mix.pessoa?.data?.nome as string | undefined);
  return value?.trim() || null;
}

export function mapPjResult(
  queryId: string,
  r: DepsConsultResultPJ
): PjInsert {
  const m = r.mix;
  return {
    query_id: queryId,
    cnpj: m.empresa.data.cnpj,
    razao_social: m.empresa.data.razaoSocial,
    nome_fantasia: m.empresa.data.nomeFantasia,
    situacao_cadastral: m.empresa.data.situacaoCadastral,
    data_inicio_atividade: m.empresa.data.dataInicioAtividade,
    cnae_principal: m.empresa.data.cnaePrincipal,
    natureza_juridica: m.empresa.data.naturezaJuridica,
    capital_social: m.empresa.data.capitalSocial,
    porte: m.empresa.data.porte,
    municipio: m.empresa.data.municipio,
    uf: m.empresa.data.uf,
    score_valor: m.score.data.valor,
    score_risco: m.score.data.risco,
    score_descricao: m.score.data.descricao,
    score_probabilidade_pagamento: m.score.data.probabilidadePagamento,
    smart_success: m.smart.success,
    smart_classificacao: json(m.smart.classificacao),
    smart_parecer: json(m.smart.parecer),
    smart_positivas: json(m.smart.positivas),
    smart_negativas: json(m.smart.negativas),
    pendencias_success: m.pendenciasRestricoes.success,
    pendencias_data: json(m.pendenciasRestricoes.data),
    acoes_judiciais_success: m.acoesJudiciais.success,
    acoes_judiciais_data: json(m.acoesJudiciais.data),
    protestos_success: m.protestos.success,
    protestos_data: json(m.protestos.data),
    quadro_societario_com_participacao: m.quadroSocietario.comParticipacao,
    quadro_societario_socios: json(m.quadroSocietario.socios),
    scr_success: m.scr.success,
    scr_data: json(m.scr.data),
    raw_response: json(m),
  };
}

export function mapPfResult(
  queryId: string,
  r: DepsConsultResultPF
): PfInsert {
  const m = r.mix;
  return {
    query_id: queryId,
    cpf: m.pessoa.data.cpf,
    nome: m.pessoa.data.nome,
    nome_mae: m.pessoa.data.nomeMae,
    data_nascimento: m.pessoa.data.dataNascimento,
    idade: m.pessoa.data.idade,
    situacao_cadastral: m.pessoa.data.situacaoCadastral,
    obito: m.pessoa.data.obito,
    politicamente_exposta: m.pessoa.data.politicamenteExposta,
    cidade: m.pessoa.data.municipio,
    uf: m.pessoa.data.uf,
    score_valor: m.score.data.valor,
    score_risco: m.score.data.risco,
    score_descricao: m.score.data.descricao,
    score_probabilidade_pagamento: m.score.data.probabilidadePagamento,
    renda_presumida_descricao: m.rendaPresumida.data.descricao,
    renda_presumida_valor: m.rendaPresumida.data.valor,
    renda_presumida_valor_minimo: m.rendaPresumida.data.valorMinimo,
    renda_presumida_valor_maximo: m.rendaPresumida.data.valorMaximo,
    scr_success: m.scr.success,
    scr_risco_total: m.scr.data?.riscoTotal ?? null,
    scr_carteira_ativa: m.scr.data?.carteiraAtiva ?? null,
    scr_limite_credito: m.scr.data?.limiteCredito ?? null,
    scr_a_vencer_total: m.scr.data?.aVencerTotal ?? null,
    scr_vencido_total: m.scr.data?.vencidoTotal ?? null,
    pendencias_success: m.pendenciasRestricoes.success,
    pendencias_total: m.pendenciasRestricoes.data?.total ?? null,
    pendencias_valor_total: m.pendenciasRestricoes.data?.valorTotal ?? null,
    pendencias_ocorrencias: json(m.pendenciasRestricoes.data?.ocorrencias ?? null),
    acoes_judiciais_success: m.acoesJudiciais.success,
    acoes_judiciais_total: m.acoesJudiciais.data?.total ?? null,
    acoes_judiciais_valor_total: m.acoesJudiciais.data?.valorTotal ?? null,
    acoes_judiciais_ocorrencias: json(m.acoesJudiciais.data?.ocorrencias ?? null),
    protestos_success: m.protestos.success,
    protestos_data: json(m.protestos.data),
    smart_success: m.smart.success,
    smart_classificacao: json(m.smart.classificacao),
    smart_parecer: json(m.smart.parecer),
    smart_positivas: json(m.smart.positivas),
    smart_negativas: json(m.smart.negativas),
    participacao_empresa_success: m.participacaoEmpresa.success,
    participacao_empresa_data: json(m.participacaoEmpresa.data),
    raw_response: json(m),
  };
}
