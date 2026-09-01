// Versioned DEPS canonical adapter — the ONE provider trust boundary.
// Raw DEPS body (`unknown`) -> validated `CanonicalBureauResult` (version 1).
//
// Rules (spec 2026-08-29-postgres-docker-security-design.md §160-171):
//  - Additive/unknown fields NEVER fail validation and are NOT copied into the
//    canonical result (they live only in raw storage, added in Task 7).
//  - Required identity (subject name + document) fails CLOSED — no blank
//    "completed" consultation.
//  - No `as unknown as` / whole-payload casts to trust external data.
//  - Errors carry JSON paths, never a value copied from the payload.

import { z } from "zod";

import {
  ADAPTER_VERSION,
  type AdaptContext,
  type AdaptResult,
  type AdapterError,
  type BureauEntityKind,
  type CanonicalBureauResult,
  type CanonicalDebtItem,
  type CanonicalOwner,
  type CanonicalParticipation,
  type CanonicalQueryItem,
} from "@/types/bureau";

// ── small runtime guards / coercion ──────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// DEPS modules are `{ success, message, data }`; some legacy variants inline the
// payload. Return `.data` when present, otherwise the value itself.
const moduleData = (v: unknown): unknown =>
  isRecord(v) && "data" in v ? v.data : v;

const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const digits = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(Math.abs(v)));
  if (typeof v !== "string") return null;
  const d = v.replace(/\D/g, "");
  return d.length > 0 ? d : null;
};

// Accepts numbers, "1234.56", pt-BR "1.234,56" / "1234,56", "R$ 1.234,56".
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[R$\s ]/gi, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const cents = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n * 100);
};

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const boundedInt = (v: unknown, min: number, max: number): number | null => {
  const n = num(v);
  if (n == null) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const sumCents = (items: { amountCents: number | null }[]): number | null => {
  const present = items.filter((i) => i.amountCents != null);
  if (present.length === 0) return null;
  return present.reduce((a, i) => a + (i.amountCents ?? 0), 0);
};

const fail = (errors: AdapterError[]): AdaptResult => ({
  ok: false,
  version: ADAPTER_VERSION,
  errors,
});

// ── envelope unwrap ──────────────────────────────────────────────────────
// DEPS returns `[{ mix: {...} }]`, `{ mix: {...} }`, or the mix object directly.
function extractMix(body: unknown): Record<string, unknown> | null {
  const root = Array.isArray(body) ? body[0] : body;
  if (!isRecord(root)) return null;
  if (isRecord(root.mix)) return root.mix;
  return root;
}

// ── required identity (Zod — fails closed) ───────────────────────────────

const docLike = z.union([z.string(), z.number()]);

const pfIdentity = z
  .object({ nome: z.string().trim().min(1), cpf: docLike })
  .passthrough();
const pjIdentity = z
  .object({ razaoSocial: z.string().trim().min(1), cnpj: docLike })
  .passthrough();

const IDENTITY_PATH: Record<string, string> = {
  nome: "subject.name",
  razaoSocial: "subject.name",
  cpf: "document.value",
  cnpj: "document.value",
};

function identityErrors(raw: unknown, kind: BureauEntityKind): AdapterError[] {
  const schema = kind === "PF" ? pfIdentity : pjIdentity;
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "");
      return {
        path: IDENTITY_PATH[key] ?? `subject.${i.path.join(".")}`,
        code: i.code,
        message: i.message,
      };
    });
  }
  const rec = isRecord(raw) ? raw : {};
  if (!digits(kind === "PF" ? rec.cpf : rec.cnpj)) {
    return [
      {
        path: "document.value",
        code: "missing_document",
        message: "Required document identifier is missing or not numeric",
      },
    ];
  }
  return [];
}

// ── section mappers ──────────────────────────────────────────────────────

function mapDebts(mix: Record<string, unknown>): CanonicalBureauResult["debts"] {
  const items: CanonicalDebtItem[] = [];

  const pend = moduleData(mix.pendenciasRestricoes);
  if (isRecord(pend)) {
    for (const o of asArray(pend.ocorrencias)) {
      if (!isRecord(o)) continue;
      items.push({
        source: str(o.informante),
        kind: str(o.tipo),
        amountCents: cents(o.valor),
        date: iso(o.dataDebito ?? o.data),
        city: str(o.cidade),
        state: str(o.uf),
      });
    }
  }

  const acoes = moduleData(mix.acoesJudiciais);
  if (isRecord(acoes)) {
    for (const o of asArray(acoes.ocorrencias)) {
      if (!isRecord(o)) continue;
      items.push({
        source: "acao_judicial",
        kind: str(o.acao),
        amountCents: cents(o.valor),
        date: iso(o.distribuicao ?? o.data),
        city: str(o.comarca ?? o.foro),
        state: str(o.uf),
      });
    }
  }

  return { total: items.length, amountCents: sumCents(items), items };
}

// ── protestos: DEPS returns a consolidated OBJECT (not a list); normalize both
// the current object shape and the legacy array shape. Inlined from the former
// deps/protestos.ts (its only importer).
interface ProtestoOcorrencia {
  cartorio: string | null;
  uf: string | null;
  data: string | null;
  valor: number | null;
}
interface ProtestosSummary {
  total: number;
  valorTotal: number | null;
  ocorrencias: ProtestoOcorrencia[];
}

function summarizeProtestos(data: unknown): ProtestosSummary {
  const EMPTY: ProtestosSummary = { total: 0, valorTotal: null, ocorrencias: [] };
  const pStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const pNum = (v: unknown): number | null => (typeof v === "number" ? v : null);

  if (data == null) return EMPTY;

  if (Array.isArray(data)) {
    const ocorrencias = data.map((o) => {
      const r = (o ?? {}) as Record<string, unknown>;
      return {
        cartorio: pStr(r.cartorio),
        uf: pStr(r.uf),
        data: pStr(r.data),
        valor: pNum(r.valor),
      };
    });
    const soma = ocorrencias.reduce((acc, o) => acc + (o.valor ?? 0), 0);
    return { total: ocorrencias.length, valorTotal: soma || null, ocorrencias };
  }

  if (typeof data !== "object") return EMPTY;
  const d = data as Record<string, unknown>;

  const ocorrencias: ProtestoOcorrencia[] = [];
  const cartorios = Array.isArray(d.cartorios) ? d.cartorios : [];
  for (const c of cartorios) {
    const cr = (c ?? {}) as Record<string, unknown>;
    const lista = Array.isArray(cr.protestos) ? cr.protestos : [];
    for (const p of lista) {
      const pr = (p ?? {}) as Record<string, unknown>;
      ocorrencias.push({
        cartorio: pStr(cr.nome),
        uf: pStr(cr.uf),
        data: pStr(pr.data),
        valor: pNum(pr.valor),
      });
    }
  }
  if (ocorrencias.length === 0 && Array.isArray(d.ultimasOcorrencias)) {
    for (const o of d.ultimasOcorrencias) {
      const r = (o ?? {}) as Record<string, unknown>;
      ocorrencias.push({
        cartorio: pStr(r.cartorio),
        uf: pStr(r.uf),
        data: pStr(r.data),
        valor: pNum(r.valor),
      });
    }
  }

  const total = pNum(d.quantidadeTotal) ?? ocorrencias.length;
  const valorTotal =
    pNum(d.valorTotal) ??
    (ocorrencias.length > 0
      ? ocorrencias.reduce((acc, o) => acc + (o.valor ?? 0), 0) || null
      : null);

  return { total, valorTotal, ocorrencias };
}

function mapProtests(mix: Record<string, unknown>): CanonicalBureauResult["protests"] {
  const s = summarizeProtestos(moduleData(mix.protestos));
  return {
    total: s.total,
    amountCents: cents(s.valorTotal),
    items: s.ocorrencias.map((o) => ({
      registry: o.cartorio,
      state: o.uf,
      date: iso(o.data),
      amountCents: cents(o.valor),
    })),
  };
}

function mapChecks(mix: Record<string, unknown>): CanonicalBureauResult["checks"] {
  const cd = moduleData(mix.restricoesCheques);
  const c = isRecord(cd) ? cd : {};
  const semFundo = isRecord(c.chequesDevolvidosSemFundo)
    ? c.chequesDevolvidosSemFundo
    : null;
  return {
    hasInfo: bool(c.possuiInformacao),
    returnedNoFunds: num(c.devolvidosSemFundo),
    stopped: num(c.sustados),
    note: semFundo ? str(semFundo.message) : null,
  };
}

function mapQueries(mix: Record<string, unknown>): CanonicalBureauResult["queries"] {
  const q = moduleData(mix.consultas);
  const d = isRecord(q) ? q : {};
  const items: CanonicalQueryItem[] = asArray(d.detalhes)
    .filter(isRecord)
    .map((x) => ({
      date: iso(x.dataConsulta),
      segment: str(x.segmento),
      count: num(x.quantidadeConsultas),
    }));
  return {
    last30Days: num(d.contagemUltimos30Dias),
    last31To60Days: num(d.contagemUltimos31a60Dias),
    last61To90Days: num(d.contagemUltimos61a90Dias),
    over90Days: num(d.contagem90DiasMais),
    items,
  };
}

function mapOwnership(mix: Record<string, unknown>): CanonicalOwner[] {
  const qs = mix.quadroSocietario;
  const data = moduleData(qs);
  const list =
    (isRecord(data) && (asArray(data.socios).length ? data.socios : data.quadroSocietario)) ??
    (isRecord(qs) ? qs.socios : undefined);
  return asArray(list)
    .filter(isRecord)
    .map((s) => ({
      name: str(s.nome),
      document: digits(s.documento),
      sharePct: num(s.participacao ?? s.percentualParticipacao),
      role: str(s.cargoSociedade ?? s.cargo),
    }));
}

function mapParticipation(mix: Record<string, unknown>): CanonicalParticipation[] {
  return asArray(moduleData(mix.participacaoEmpresa))
    .filter(isRecord)
    .map((p) => ({
      document: digits(p.cnpj),
      name: str(p.nome),
      sharePct: num(p.percentualParticipacao ?? p.participacao),
      role: str(p.cargo),
    }));
}

const MESSAGE_MODULES = [
  "pessoa",
  "empresa",
  "score",
  "smart",
  "scr",
  "pendenciasRestricoes",
  "acoesJudiciais",
  "protestos",
  "quadroSocietario",
  "participacaoEmpresa",
  "consultas",
  "rendaPresumida",
];

function collectMessages(mix: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const key of MESSAGE_MODULES) {
    const mod = mix[key];
    if (isRecord(mod) && typeof mod.message === "string" && mod.message.trim()) {
      seen.add(mod.message.trim());
    }
  }
  return Array.from(seen);
}

// ── entry point ──────────────────────────────────────────────────────────

export function adapt(body: unknown, ctx: AdaptContext): AdaptResult {
  const receivedAt =
    iso(ctx.receivedAt instanceof Date ? ctx.receivedAt.toISOString() : ctx.receivedAt) ??
    new Date().toISOString();

  const mix = extractMix(body);
  if (!mix) {
    return fail([
      { path: "", code: "root_not_object", message: "Response root is not an object" },
    ]);
  }

  const pessoa = moduleData(mix.pessoa);
  const empresa = moduleData(mix.empresa);
  const kind: BureauEntityKind | null = isRecord(empresa)
    ? "PJ"
    : isRecord(pessoa)
      ? "PF"
      : null;

  if (!kind) {
    return fail([
      {
        path: "subject.name",
        code: "missing_identity",
        message: "No recognized subject identity block (pessoa / empresa)",
      },
      {
        path: "document.value",
        code: "missing_document",
        message: "No recognized document identifier",
      },
    ]);
  }

  const identity = (kind === "PF" ? pessoa : empresa) as Record<string, unknown>;
  const idErrors = identityErrors(identity, kind);
  if (idErrors.length > 0) return fail(idErrors);

  const score = moduleData(mix.score);
  const scoreRec = isRecord(score) ? score : {};
  const address =
    kind === "PF" && isRecord(identity.dadosCadastrais) ? identity.dadosCadastrais : {};

  const registrationStatus = str(identity.situacaoCadastral);

  const value: CanonicalBureauResult = {
    document: {
      type: kind === "PF" ? "cpf" : "cnpj",
      value: digits(kind === "PF" ? identity.cpf : identity.cnpj) ?? "",
    },
    subject: {
      kind,
      name: str(kind === "PF" ? identity.nome : identity.razaoSocial) ?? "",
      tradeName: kind === "PJ" ? str(identity.nomeFantasia) : null,
      motherName: kind === "PF" ? str(identity.nomeMae) : null,
      birthDate: kind === "PF" ? iso(identity.dataNascimento) : null,
      age: kind === "PF" ? boundedInt(identity.idade, 0, 200) : null,
      registrationStatus,
      isDeceased: kind === "PF" ? bool(identity.obito) : null,
      isPoliticallyExposed: kind === "PF" ? bool(identity.politicamenteExposta) : null,
      legalNature: kind === "PJ" ? str(identity.naturezaJuridica) : null,
      mainActivity: kind === "PJ" ? str(identity.cnaePrincipal) : null,
      companySize: kind === "PJ" ? str(identity.porte) : null,
      capitalCents: kind === "PJ" ? cents(identity.capitalSocial) : null,
      startDate: kind === "PJ" ? iso(identity.dataInicioAtividade) : null,
      city: str(identity.municipio ?? identity.cidade ?? address.cidade),
      state: str(identity.uf ?? address.uf),
    },
    score: {
      value: boundedInt(scoreRec.valor ?? scoreRec.score, 0, 1000),
      riskBand: str(scoreRec.risco),
      description: str(scoreRec.descricao),
      paymentProbability: boundedInt(scoreRec.probabilidadePagamento, 0, 100),
    },
    registrationStatus,
    debts: mapDebts(mix),
    protests: mapProtests(mix),
    checks: mapChecks(mix),
    queries: mapQueries(mix),
    companyOwnership: kind === "PJ" ? mapOwnership(mix) : [],
    participation: kind === "PF" ? mapParticipation(mix) : [],
    messages: collectMessages(mix),
    provider: {
      product: ctx.product,
      httpStatus: ctx.httpStatus,
      receivedAt,
      apiVersion: num(mix.versao),
      consultedAt: iso(mix.dataConsulta),
      consultationId: str(mix.historicoConsultaId),
    },
  };

  return { ok: true, value, version: ADAPTER_VERSION };
}
