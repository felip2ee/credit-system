// Presentation view-model — the ONE place the canonical bureau result is turned
// into display-ready strings for the detail screen and the PDF.
//
// Consumes `CanonicalBureauResult` only. No provider-shape conditionals
// (`row.smart_*`, `Mod<T>`, `.mix`, wide-table columns). Optional sections come
// out of the adapter as empty arrays / null by contract, so every section here
// just carries an `empty` flag the renderer can branch on.

import type { CanonicalBureauResult } from "@/types/bureau";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

// cents (integer) -> "R$ 1.234,56"; null -> "—".
function money(cents: number | null): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
}

function loc(city: string | null, state: string | null): string | null {
  if (city && state) return `${city}/${state}`;
  return city ?? state ?? null;
}

// Task 6 carried minor: `collectMessages` emits generic tokens ("ok", "sucesso")
// alongside the meaningful "Nada consta". Filter the noise for display.
const GENERIC_MESSAGE = new Set(["ok", "okay", "sucesso", "success", "true", "-"]);
function meaningfulMessages(messages: string[]): string[] {
  return messages.filter((m) => {
    const t = m.trim().toLowerCase();
    return t.length > 2 && !GENERIC_MESSAGE.has(t);
  });
}

export interface DebtRow {
  source: string | null;
  kind: string | null;
  amount: string;
  date: string | null;
  location: string | null;
}

export interface ConsultationView {
  incompatible: false;
  kind: "PF" | "PJ";
  subject: {
    name: string;
    documentLabel: "CPF" | "CNPJ";
    tradeName: string | null;
    motherName: string | null;
    birthDate: string | null;
    age: number | null;
    registrationStatus: string | null;
    isDeceased: boolean;
    isPoliticallyExposed: boolean;
    legalNature: string | null;
    mainActivity: string | null;
    companySize: string | null;
    capital: string | null;
    startDate: string | null;
    location: string | null;
  };
  score: {
    empty: boolean;
    value: number | null;
    riskBand: string | null;
    description: string | null;
    paymentProbability: number | null;
  };
  debts: { empty: boolean; total: number; amount: string; items: DebtRow[] };
  lawsuits: { empty: boolean; total: number; amount: string; items: DebtRow[] };
  protests: {
    empty: boolean;
    total: number;
    amount: string;
    items: { registry: string | null; state: string | null; date: string | null; amount: string }[];
  };
  checks: {
    empty: boolean;
    hasInfo: boolean | null;
    returnedNoFunds: number | null;
    stopped: number | null;
    note: string | null;
  };
  queries: {
    empty: boolean;
    last30Days: number | null;
    last31To60Days: number | null;
    last61To90Days: number | null;
    over90Days: number | null;
    items: { date: string | null; segment: string | null; count: number | null }[];
  };
  ownership: {
    empty: boolean;
    items: { name: string | null; document: string | null; sharePct: number | null; role: string | null }[];
  };
  participation: {
    empty: boolean;
    items: { name: string | null; document: string | null; sharePct: number | null; role: string | null }[];
  };
  messages: string[];
  provider: { product: string; consultedAt: string | null };
}

export interface IncompatibleView {
  incompatible: true;
  consultationId: string;
  message: string;
}

const INCOMPATIBLE_MESSAGE =
  "Não foi possível exibir esta consulta: os dados retornados pelo bureau não são " +
  "compatíveis com o formato atual. Encaminhe o código da consulta ao suporte.";

// Safe path for `payload_incompatible` consultations — never touches a result.
export function incompatibleView(consultationId: string): IncompatibleView {
  return { incompatible: true, consultationId, message: INCOMPATIBLE_MESSAGE };
}

export function toConsultationView(c: CanonicalBureauResult): ConsultationView {
  const debtItems = c.debts.items.filter((i) => i.source !== "acao_judicial");
  const lawsuitItems = c.debts.items.filter((i) => i.source === "acao_judicial");

  const mapDebt = (i: CanonicalBureauResult["debts"]["items"][number]): DebtRow => ({
    source: i.source,
    kind: i.kind,
    amount: money(i.amountCents),
    date: formatDateOrNull(i.date),
    location: loc(i.city, i.state),
  });

  const s = c.subject;
  const scoreEmpty =
    c.score.value == null && c.score.riskBand == null && c.score.description == null;

  const checksEmpty =
    c.checks.hasInfo == null &&
    (c.checks.returnedNoFunds ?? 0) === 0 &&
    (c.checks.stopped ?? 0) === 0 &&
    c.checks.note == null;

  const queriesEmpty =
    c.queries.items.length === 0 &&
    c.queries.last30Days == null &&
    c.queries.last31To60Days == null &&
    c.queries.last61To90Days == null &&
    c.queries.over90Days == null;

  return {
    incompatible: false,
    kind: s.kind,
    subject: {
      name: s.name,
      documentLabel: c.document.type === "cpf" ? "CPF" : "CNPJ",
      tradeName: s.tradeName,
      motherName: s.motherName,
      birthDate: formatDateOrNull(s.birthDate),
      age: s.age,
      registrationStatus: s.registrationStatus,
      isDeceased: s.isDeceased === true,
      isPoliticallyExposed: s.isPoliticallyExposed === true,
      legalNature: s.legalNature,
      mainActivity: s.mainActivity,
      companySize: s.companySize,
      capital: s.capitalCents == null ? null : money(s.capitalCents),
      startDate: formatDateOrNull(s.startDate),
      location: loc(s.city, s.state),
    },
    score: {
      empty: scoreEmpty,
      value: c.score.value,
      riskBand: c.score.riskBand,
      description: c.score.description,
      paymentProbability: c.score.paymentProbability,
    },
    debts: {
      empty: debtItems.length === 0,
      total: debtItems.length,
      amount: money(sumCents(debtItems)),
      items: debtItems.map(mapDebt),
    },
    lawsuits: {
      empty: lawsuitItems.length === 0,
      total: lawsuitItems.length,
      amount: money(sumCents(lawsuitItems)),
      items: lawsuitItems.map(mapDebt),
    },
    protests: {
      empty: c.protests.items.length === 0 && c.protests.total === 0,
      total: c.protests.total,
      amount: money(c.protests.amountCents),
      items: c.protests.items.map((p) => ({
        registry: p.registry,
        state: p.state,
        date: formatDateOrNull(p.date),
        amount: money(p.amountCents),
      })),
    },
    checks: {
      empty: checksEmpty,
      hasInfo: c.checks.hasInfo,
      returnedNoFunds: c.checks.returnedNoFunds,
      stopped: c.checks.stopped,
      note: c.checks.note,
    },
    queries: {
      empty: queriesEmpty,
      last30Days: c.queries.last30Days,
      last31To60Days: c.queries.last31To60Days,
      last61To90Days: c.queries.last61To90Days,
      over90Days: c.queries.over90Days,
      items: c.queries.items.map((q) => ({
        date: formatDateOrNull(q.date),
        segment: q.segment,
        count: q.count,
      })),
    },
    ownership: { empty: c.companyOwnership.length === 0, items: c.companyOwnership },
    participation: { empty: c.participation.length === 0, items: c.participation },
    messages: meaningfulMessages(c.messages),
    provider: { product: c.provider.product, consultedAt: c.provider.consultedAt },
  };
}

function sumCents(items: { amountCents: number | null }[]): number | null {
  const present = items.filter((i) => i.amountCents != null);
  if (present.length === 0) return null;
  return present.reduce((a, i) => a + (i.amountCents ?? 0), 0);
}

function formatDateOrNull(iso: string | null): string | null {
  return iso ? formatDate(iso) : null;
}

// Formatted document string, from the digits-only canonical value. Kept out of
// `toConsultationView` so the redacted AI path never accidentally pulls it in.
export function formatSubjectDocument(c: CanonicalBureauResult): string {
  return c.document.type === "cpf"
    ? formatCPF(c.document.value)
    : formatCNPJ(c.document.value);
}
