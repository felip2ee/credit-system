// Tipos das respostas da API deps.com.br (Smart PF 002 / Smart PJ 010).
// Modela os módulos que armazenamos (query_results_pf/pj) e que o agente de IA consome.
// O formato espelha o `mix.*` da deps para que o client real mapeie 1:1.

export type DepsEntityKind = "PF" | "PJ";

export interface DepsModule<T> {
  success: boolean;
  message: string;
  data: T;
}

// ─── Blocos compartilhados ────────────────────────────────────────────────

export interface ScoreData {
  valor: number; // 0–1000
  risco: string; // "Muito baixo" | "Baixo" | "Médio" | "Alto" | "Muito alto"
  descricao: string;
  probabilidadePagamento: number; // %
}

export interface SmartMetrica {
  metrica: string;
  descricao: string;
  pontuacao: number;
  impacto: "POSITIVO" | "NEGATIVO";
}

export interface SmartClassificacao {
  classificacao: string; // E..AAA
  limiteSugerido: number;
  limiteRequisitado: number;
  pontuacaoAtingida: number;
  porte: string;
}

export interface SmartParecer {
  aprovado: boolean;
  motivo: string;
  limiteRequisitado: number;
}

export interface SmartData {
  success: boolean;
  message: string;
  classificacao: SmartClassificacao;
  parecer: SmartParecer;
  positivas: SmartMetrica[];
  negativas: SmartMetrica[];
}

export interface Pendencia {
  informante: string;
  tipo: string;
  valor: number;
  data: string;
  cidade?: string;
  uf?: string;
}

export interface PendenciasData {
  total: number;
  totalCredores: number;
  valorTotal: number;
  ocorrencias: Pendencia[];
}

export interface AcaoJudicial {
  acao: string;
  valor: number;
  foro?: string;
  vara?: string;
  processo?: string;
  distribuicao?: string;
}

export interface AcoesJudiciaisData {
  total: number;
  valorTotal: number;
  ocorrencias: AcaoJudicial[];
}

export interface Protesto {
  cartorio?: string;
  valor: number;
  data: string;
  cidade?: string;
  uf?: string;
}

export interface ChequesData {
  possuiInformacao: boolean;
  devolvidosSemFundo: number;
  sustados: number;
}

// ─── SCR ───────────────────────────────────────────────────────────────────

// PJ: dado simples (apenas presença)
export interface ScrSimple {
  possuiOperacoes: boolean;
}

// PF: detalhamento de carteira
export interface ScrDetailed {
  riscoTotal: number;
  carteiraAtiva: number;
  limiteCredito: number;
  aVencerTotal: number;
  vencidoTotal: number;
}

// ─── Identidade ──────────────────────────────────────────────────────────

export interface EmpresaData {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  situacaoCadastral: string;
  dataInicioAtividade: string;
  cnaePrincipal: string;
  naturezaJuridica: string;
  capitalSocial: number;
  porte: string;
  municipio: string;
  uf: string;
}

export interface PessoaData {
  cpf: string;
  nome: string;
  nomeMae: string;
  dataNascimento: string;
  idade: number;
  situacaoCadastral: string;
  obito: boolean;
  politicamenteExposta: boolean;
  municipio: string;
  uf: string;
}

export interface Socio {
  nome: string;
  documento: string;
  participacao: number;
  cargoSociedade: string;
}

export interface Participacao {
  cnpj: string;
  nome: string;
  percentualParticipacao: number;
  cargo: string;
}

export interface RendaPresumida {
  descricao: string;
  valor: number;
  valorMinimo: number;
  valorMaximo: number;
}

// ─── Resultado da consulta ──────────────────────────────────────────────

interface DepsConsultBase {
  historicoConsultaId: string;
  document: string;
  consultedAt: string;
  apiVersion: number;
  productVersion: string;
  isPartial: boolean;
  shareLink: string | null;
}

export interface DepsConsultResultPJ extends DepsConsultBase {
  type: "PJ";
  mix: {
    empresa: DepsModule<EmpresaData>;
    score: DepsModule<ScoreData>;
    smart: SmartData;
    // A deps devolve `data: null` nestes blocos quando a entidade não os possui.
    pendenciasRestricoes: DepsModule<PendenciasData | null>;
    acoesJudiciais: DepsModule<AcoesJudiciaisData | null>;
    protestos: DepsModule<Protesto[]>;
    restricoesCheques: ChequesData;
    scr: DepsModule<ScrSimple | null>;
    quadroSocietario: { comParticipacao: boolean; socios: Socio[] };
  };
  raw?: Record<string, unknown>;
}

export interface DepsConsultResultPF extends DepsConsultBase {
  type: "PF";
  mix: {
    pessoa: DepsModule<PessoaData>;
    score: DepsModule<ScoreData>;
    smart: SmartData;
    rendaPresumida: DepsModule<RendaPresumida>;
    // A deps devolve `data: null` nestes blocos quando a entidade não os possui.
    scr: DepsModule<ScrDetailed | null>;
    pendenciasRestricoes: DepsModule<PendenciasData | null>;
    acoesJudiciais: DepsModule<AcoesJudiciaisData | null>;
    protestos: DepsModule<Protesto[]>;
    restricoesCheques: ChequesData;
    participacaoEmpresa: DepsModule<Participacao[]>;
  };
  raw?: Record<string, unknown>;
}

export type DepsConsultResult = DepsConsultResultPF | DepsConsultResultPJ;

export interface ConsultOptions {
  product?: string;
  includeScr?: boolean;
  // Quando true, a deps reaproveita os dados já existentes da consulta
  // (não gera nova cobrança). Default true. Desmarque para forçar consulta nova.
  reuseExisting?: boolean;
  // Dados do titular para a solicitação de autorização SCR. Quando presente (com
  // e-mail), a consulta inclui `autorizacaoConsulta` no corpo: se o SCR ainda não
  // foi aceito, a deps (re)envia o e-mail de autorização e retorna HTTP 400.
  authorization?: { name?: string; email?: string };
}

// ─── SCR (autorização) ─────────────────────────────────────────────────

export type ScrAuthorizationStatus =
  | "authorized"
  | "pending"
  | "not_authorized"
  | "expired";

export interface ScrAuthorizationCheck {
  document: string;
  status: ScrAuthorizationStatus;
  authorizedAt: string | null;
  expiresAt: string | null;
  message: string;
}

export interface ScrRequestInput {
  document: string;
  type: DepsEntityKind;
  name?: string;
  email?: string;
}

export interface ScrRequestResult {
  document: string;
  status: "pending";
  requestedAt: string;
  message: string;
}

// ─── Interface do client ─────────────────────────────────────────────────

export interface DepsClient {
  readonly mode: "real";
  consultPF(cpf: string, options?: ConsultOptions): Promise<DepsConsultResultPF>;
  consultPJ(cnpj: string, options?: ConsultOptions): Promise<DepsConsultResultPJ>;
  checkScrAuthorization(document: string): Promise<ScrAuthorizationCheck>;
  requestScrAuthorization(input: ScrRequestInput): Promise<ScrRequestResult>;
}
