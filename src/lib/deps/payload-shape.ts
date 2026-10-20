// Forma do payload bruto da DEPS: envelopes de módulo `{ success, message, data, info? }`.

export interface ModuleEnvelope {
  success: unknown;
  message: unknown;
  data: unknown;
  info?: unknown;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["success", "message", "data", "info"]);
const EMPTY_MESSAGES: ReadonlySet<string> = new Set(["", "sem informação", "nada consta"]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Envelope = registro com "success" e "data" e nenhuma chave fora de {success, message, data, info}.
export function isEnvelope(value: unknown): value is ModuleEnvelope {
  if (!isRecord(value) || !("success" in value) || !("data" in value)) return false;
  return Object.keys(value).every((key) => ENVELOPE_KEYS.has(key));
}

// Módulo ausente: null/undefined, ou envelope sem dados e sem mensagem de erro.
export function isMissingModule(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isEnvelope(value) || value.data !== null) return false;
  if (value.message === null || value.message === undefined) return true;
  if (typeof value.message !== "string") return false;
  return EMPTY_MESSAGES.has(value.message.trim().replace(/\.$/, "").toLowerCase());
}

// Rodapé do mix (spec §3.2 item 11), na ordem da spec.
export const META_KEYS: readonly string[] = [
  "versao",
  "produto",
  "dataConsulta",
  "consultante",
  "usuario",
  "historicoConsultaId",
  "isParcial",
  "isGrupo",
  "centroCusto",
  "blocosComErros",
  "linkCompartilhamento",
];

export const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["cpf", "cnpj", "documento"]);

// Chave que pode carregar um documento (`cpf`, `cnpjEmpresa`, `documentoSocio`…): sempre mascarar o valor.
const DOCUMENT_KEY = /cpf|cnpj|documento/i;
export const isDocumentKey = (key: string): boolean => DOCUMENT_KEY.test(key);
