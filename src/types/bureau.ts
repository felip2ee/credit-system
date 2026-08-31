// Canonical bureau result — the single provider-independent trust boundary output.
// Version 1. Every display / PDF / AI consumer reads THIS shape, never raw provider JSON.
// Optional sections are empty arrays or null BY CONTRACT — never shape-dependent unions.

export const ADAPTER_VERSION = 1 as const;
export type AdapterVersion = typeof ADAPTER_VERSION;

export type BureauEntityKind = "PF" | "PJ";

export interface CanonicalDocument {
  type: "cpf" | "cnpj";
  value: string; // digits only
}

export interface CanonicalSubject {
  kind: BureauEntityKind;
  name: string;
  tradeName: string | null; // PJ nome fantasia
  motherName: string | null; // PF
  birthDate: string | null; // ISO, PF
  age: number | null; // PF
  registrationStatus: string | null;
  isDeceased: boolean | null; // PF
  isPoliticallyExposed: boolean | null; // PF
  legalNature: string | null; // PJ
  mainActivity: string | null; // PJ CNAE principal
  companySize: string | null; // PJ porte
  capitalCents: number | null; // PJ capital social, integer cents
  startDate: string | null; // ISO, PJ início de atividade
  city: string | null;
  state: string | null;
}

export interface CanonicalScore {
  value: number | null; // bounded integer 0..1000
  riskBand: string | null;
  description: string | null;
  paymentProbability: number | null; // bounded 0..100
}

export interface CanonicalDebtItem {
  source: string | null; // informante, or "acao_judicial"
  kind: string | null;
  amountCents: number | null;
  date: string | null; // ISO
  city: string | null;
  state: string | null;
}

export interface CanonicalDebts {
  total: number;
  amountCents: number | null;
  items: CanonicalDebtItem[];
}

export interface CanonicalProtestItem {
  registry: string | null;
  state: string | null;
  date: string | null; // ISO
  amountCents: number | null;
}

export interface CanonicalProtests {
  total: number;
  amountCents: number | null;
  items: CanonicalProtestItem[];
}

export interface CanonicalChecks {
  hasInfo: boolean | null;
  returnedNoFunds: number | null;
  stopped: number | null;
  note: string | null;
}

export interface CanonicalQueryItem {
  date: string | null; // ISO
  segment: string | null;
  count: number | null;
}

export interface CanonicalQueries {
  last30Days: number | null;
  last31To60Days: number | null;
  last61To90Days: number | null;
  over90Days: number | null;
  items: CanonicalQueryItem[];
}

export interface CanonicalOwner {
  name: string | null;
  document: string | null; // digits only
  sharePct: number | null;
  role: string | null;
}

export interface CanonicalParticipation {
  document: string | null; // CNPJ digits only
  name: string | null;
  sharePct: number | null;
  role: string | null;
}

export interface CanonicalProviderMeta {
  product: string;
  httpStatus: number;
  receivedAt: string; // ISO
  apiVersion: number | null;
  consultedAt: string | null; // ISO
  consultationId: string | null;
}

export interface CanonicalBureauResult {
  subject: CanonicalSubject;
  document: CanonicalDocument;
  score: CanonicalScore;
  registrationStatus: string | null;
  debts: CanonicalDebts;
  protests: CanonicalProtests;
  checks: CanonicalChecks;
  queries: CanonicalQueries;
  companyOwnership: CanonicalOwner[]; // PJ quadro societário
  participation: CanonicalParticipation[]; // PF participação em empresas
  messages: string[]; // provider module messages (e.g. "Nada consta")
  provider: CanonicalProviderMeta;
}

// An adapter failure. Carries a JSON path into the payload and a safe diagnostic
// code/message — NEVER a value copied from the payload.
export interface AdapterError {
  path: string; // e.g. "subject.name", "" for the root
  code: string;
  message: string;
}

export type AdaptResult =
  | { ok: true; value: CanonicalBureauResult; version: AdapterVersion }
  | { ok: false; errors: AdapterError[]; version: AdapterVersion };

export interface AdaptContext {
  product: string;
  httpStatus: number;
  receivedAt: string | Date;
}
