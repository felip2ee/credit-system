// Seções tipadas da visão completa (spec §3.2 itens 1-8). Cada builder lê chaves nomeadas do `mix`
// e manda todo o resto do mesmo objeto para "Outros campos": nenhum campo novo da DEPS se perde.

import { isEnvelope, isMissingModule, isRecord } from "@/lib/deps/payload-shape";
import type { FullSection, FullSectionId, GenericField, GenericValue, SectionPart } from "@/types/consultation-view";
import { formatScalar, toGenericTable, toGenericValue, visibleEntries } from "./generic-block";
import { labelFor } from "./labels";

type Rec = Record<string, unknown>;
type SectionBuilder = (mix: Rec) => FullSection | null;

export const FULL_SECTION_TITLES: Record<FullSectionId, string> = {
  score: "Score",
  smart: "Parecer Smart",
  scr: "SCR (Banco Central)",
  rendaPresumida: "Renda presumida",
  restricoes: "Restrições",
  pessoa: "Pessoa",
  contatos: "Contatos e endereços",
  consultas: "Consultas",
};

const OTHER_FIELDS = "Outros campos";
const SCORE_KEYS = ["score", "risco", "descricao", "scoreBoleto", "probabilidadePagamento", "descricaoPagamento"];
const RESULT_COLUMNS = ["nome", "atendido", "percentual", "percentualEsperado"];
const CLASSIFICATION_KEYS = ["classificacao", "limiteSugerido", "porte", "politica", "validade", "ticketMedio", "pontuacaoAtingida"];
const METRIC_COLUMNS = ["metrica", "descricao", "pontuacao", "impacto", "percentualMetrica"];
const SCR_TOTAL_KEYS = ["carteiraAtiva", "carteiraCredito", "riscoTotal", "riscoAssumido", "riscoIndireto", "responsabilidadeTotal", "coobrigacaoRecebida"];
const SCR_GROUP_KEYS = ["prejuizo", "coobrigacao", "limiteCredito", "creditoLiberar", "repasseInterfinanceiro"];
const ITEM_COLUMNS = ["descricao", "valor", "percentual"];
const GROUP_TOTAL_KEYS = ["descricaoTotal", "valorTotal", "percentualTotal"];
const INCOME_KEYS = ["valor", "valorMinimo", "valorMaximo", "rendaPresumida", "gastoEstimado", "possuiGastoEstimado"];
const PESSOA_INCOME_FIELDS: [string, string][] = [
  ["rendaPresumida", "Renda presumida no cadastro"],
  ["mensagemErroRendaPresumida", "Mensagem de erro da renda presumida"],
];
const RESTRICTION_KEYS = ["pendenciasRestricoes", "protestos", "acoesJudiciais", "restricoesCheques"];
const CONTACT_KEYS = ["contatosPreferenciais", "emails", "outrosEnderecos"];

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isBlank = (value: unknown): boolean => value === null || value === undefined || value === "";

// Objeto `data` de um módulo presente; null se o módulo falta, falhou ou não traz um objeto.
function dataOf(mix: Rec, key: string): Rec | null {
  const mod = mix[key];
  return isEnvelope(mod) && isRecord(mod.data) ? mod.data : null;
}

// Lê chaves de um objeto e lembra quais usou; rest() devolve o que sobrou (chamar por último).
function reader(obj: Rec) {
  const used = new Set<string>();
  const take = <T>(key: string, guard: (value: unknown) => value is T): T | null => {
    const value = obj[key];
    if (!guard(value)) return null;
    used.add(key);
    return value;
  };
  return {
    record: (key: string) => take(key, isRecord),
    array: (key: string) => take(key, isArray),
    fields(keys: readonly string[], depth = 2): GenericField[] {
      return keys
        .filter((key) => Object.hasOwn(obj, key))
        .map((key) => {
          used.add(key);
          return { key, label: labelFor(key), value: toGenericValue(obj[key], key, depth) };
        });
    },
    rest: (): Rec => Object.fromEntries(Object.entries(obj).filter(([key]) => !used.has(key))),
  };
}

const fieldsPart = (title: string | null, fields: GenericField[]): SectionPart | null =>
  fields.length ? { title, value: { kind: "fields", fields }, collapsed: false } : null;

// Tabela com colunas fixas; sem linhas de objeto, cai no renderizador genérico (Nenhum / JSON).
function tablePart(title: string, items: unknown[] | null, columns: string[], collapsed = false): SectionPart | null {
  if (!items) return null;
  const rows = items.filter(isRecord);
  const value = rows.length > 0 && rows.length === items.length ? toGenericTable(rows, columns) : toGenericValue(items, title, 2);
  return { title, value, collapsed };
}

const genericPart = (title: string, items: unknown[] | null, collapsed: boolean): SectionPart | null =>
  items ? { title, value: toGenericValue(items, title, 2), collapsed } : null;

function restFields(rest: Rec, depth = 2): GenericField[] {
  return visibleEntries(rest).map(([key, item]) => ({ key, label: labelFor(key), value: toGenericValue(item, key, depth) }));
}

// "Outros campos": o resto do objeto raiz mais o resto de cada objeto interno já lido (agrupado pelo nome dele).
// Vazios, identificadores e sobras de envelope ficam de fora; sem campos, a parte some.
function othersPart(rest: Rec, nested: Record<string, Rec> = {}): SectionPart | null {
  const fields = restFields(rest);
  for (const [name, innerRest] of Object.entries(nested)) {
    const innerFields = restFields(innerRest, 3);
    if (innerFields.length === 0) continue;
    fields.push({ key: name, label: labelFor(name), value: { kind: "fields", fields: innerFields } });
  }
  return fieldsPart(OTHER_FIELDS, fields);
}

// Nota do módulo (`info` do envelope), logo depois das partes dele.
function noteOf(mix: Rec, key: string): SectionPart | null {
  const mod = mix[key];
  if (!isEnvelope(mod) || isBlank(mod.info)) return null;
  return { title: "Nota", value: { kind: "text", text: formatScalar("info", mod.info) }, collapsed: false };
}

function build(id: FullSectionId, sources: string[], parts: (SectionPart | null)[]): FullSection | null {
  const present = parts.filter((part): part is SectionPart => part !== null);
  return present.length ? { id, title: FULL_SECTION_TITLES[id], sources, parts: present } : null;
}

export function scoreValueOf(mix: Rec): number | null {
  const value = dataOf(mix, "score")?.score;
  return typeof value === "number" ? value : null;
}

const buildScore: SectionBuilder = (mix) => {
  const data = dataOf(mix, "score");
  if (!data) return null;
  const r = reader(data);
  return build("score", ["score"], [fieldsPart(null, r.fields(SCORE_KEYS)), othersPart(r.rest()), noteOf(mix, "score")]);
};

const buildSmart: SectionBuilder = (mix) => {
  const data = dataOf(mix, "smart");
  if (!data) return null;
  const r = reader(data);
  const parecer = reader(r.record("parecer") ?? {});
  const classification = reader(r.record("classificacao") ?? {});
  return build("smart", ["smart"], [
    fieldsPart("Parecer", parecer.fields(["aprovado", "motivo"])),
    tablePart("Resultado do parecer", parecer.array("resultadoParecer"), RESULT_COLUMNS),
    fieldsPart("Classificação", classification.fields(CLASSIFICATION_KEYS)),
    tablePart("Métricas positivas", r.array("positivas"), METRIC_COLUMNS),
    tablePart("Métricas negativas", r.array("negativas"), METRIC_COLUMNS),
    genericPart("Todas as classificações", r.array("todasClassificacoes"), true),
    genericPart("Histórico de classificação", r.array("historicoClassificacao"), true),
    othersPart(r.rest(), { parecer: parecer.rest(), classificacao: classification.rest() }),
    noteOf(mix, "smart"),
  ]);
};

// Linha da tabela de itens: o próprio item (chaves extras viram colunas), com a descrição prefixada.
// `itensDetalhados` só fica na linha quando não foi expandido em linhas filhas.
function itemRecord(item: Rec, prefix = "", keepDetails = true): Rec {
  const entries = Object.entries(item).filter(([key, value]) => key !== "itensDetalhados" || (keepDetails && !isBlank(value)));
  return { ...Object.fromEntries(entries), descricao: prefix + formatScalar("descricao", item.descricao) };
}

// Itens do grupo, cada um seguido dos detalhes (prefixo "  — "), e por fim a linha de total.
function itemsTable(group: Rec): GenericValue {
  const rows: Rec[] = [];
  for (const item of isArray(group.itens) ? group.itens : []) {
    if (!isRecord(item)) continue;
    rows.push(itemRecord(item, "", !isArray(item.itensDetalhados)));
    for (const detail of isArray(item.itensDetalhados) ? item.itensDetalhados : []) {
      if (isRecord(detail)) rows.push(itemRecord(detail, "  — "));
    }
  }
  const extras = Object.entries(group).filter(
    ([key]) => !GROUP_TOTAL_KEYS.includes(key) && (key !== "itens" || !isArray(group.itens)),
  );
  rows.push({
    ...Object.fromEntries(extras),
    descricao: group.descricaoTotal,
    valor: group.valorTotal,
    percentual: group.percentualTotal,
  });
  return toGenericTable(rows, ITEM_COLUMNS);
}

const groupPart = (title: string, group: Rec | null): SectionPart | null =>
  group ? { title, value: itemsTable(group), collapsed: false } : null;

function queryInfoPart(items: unknown[] | null): SectionPart | null {
  const fields = (items ?? []).filter(isRecord).map((item, index): GenericField => {
    const label = typeof item.descricao === "string" ? item.descricao : `Informação ${index + 1}`;
    return { key: String(index), label, value: { kind: "text", text: formatScalar("informacao", item.valor) } };
  });
  return fieldsPart(labelFor("informacaoConsulta"), fields);
}

const buildScr: SectionBuilder = (mix) => {
  const data = dataOf(mix, "scr");
  if (!data) return null;
  const r = reader(data);
  const modality = reader(r.record("vencimentoPorModalidade") ?? {});
  const consolidated = reader(r.record("vencimentosConsolidados") ?? {});
  const totalRows = SCR_TOTAL_KEYS.flatMap((key) => {
    const total = modality.record(key);
    return total ? [itemRecord(total)] : [];
  });
  const totals: SectionPart | null = totalRows.length
    ? { title: "Totais", value: toGenericTable(totalRows, ITEM_COLUMNS), collapsed: false }
    : null;
  const toVencer = groupPart("A vencer", consolidated.record("itensAVencer"));
  const overdue = groupPart("Vencidos", consolidated.record("itensVencidos"));
  const byModality = (modality.array("vencimentoPorModalidades") ?? []).filter(isRecord).map((group) =>
    groupPart(typeof group.descricaoTotal === "string" ? group.descricaoTotal : "Modalidade", group),
  );
  const groups = SCR_GROUP_KEYS.map((key) => groupPart(labelFor(key), modality.record(key)));
  const info = queryInfoPart(consolidated.array("informacaoConsulta"));
  const others = othersPart(r.rest(), {
    vencimentoPorModalidade: modality.rest(),
    vencimentosConsolidados: consolidated.rest(),
  });
  return build("scr", ["scr"], [totals, toVencer, overdue, ...byModality, ...groups, info, others, noteOf(mix, "scr")]);
};

const buildIncome: SectionBuilder = (mix) => {
  const data = dataOf(mix, "rendaPresumida");
  if (!data) return null;
  const r = reader(data);
  const fields = r.fields(INCOME_KEYS);
  const pessoa = dataOf(mix, "pessoa");
  for (const [key, label] of PESSOA_INCOME_FIELDS) {
    const value = pessoa?.[key];
    if (!isBlank(value)) fields.push({ key: `pessoa.${key}`, label, value: toGenericValue(value, key, 2) });
  }
  return build("rendaPresumida", ["rendaPresumida"], [fieldsPart(null, fields), othersPart(r.rest()), noteOf(mix, "rendaPresumida")]);
};

function restrictionValue(key: string, value: unknown): GenericValue {
  if (isEnvelope(value) && isBlank(value.data)) {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    return { kind: "text", text: message || "Nada consta." };
  }
  return toGenericValue(value, key);
}

// Os quatro módulos aparecem sempre que existem, mesmo vazios: "Nada consta." é informação.
const buildRestrictions: SectionBuilder = (mix) => {
  const present = RESTRICTION_KEYS.filter((key) => !isBlank(mix[key]));
  const parts = present.flatMap((key): (SectionPart | null)[] => [
    { title: labelFor(key), value: restrictionValue(key, mix[key]), collapsed: false },
    noteOf(mix, key),
  ]);
  return build("restricoes", present, parts);
};

const buildPessoa: SectionBuilder = (mix) => {
  const data = dataOf(mix, "pessoa");
  if (!data) return null;
  // Renda presumida do cadastro já aparece no cartão de renda, quando ele existe.
  const hidden = dataOf(mix, "rendaPresumida") ? PESSOA_INCOME_FIELDS.map(([key]) => key) : [];
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !hidden.includes(key)));
  return build("pessoa", ["pessoa"], [
    { title: null, value: toGenericValue(rest, "pessoa"), collapsed: false },
    noteOf(mix, "pessoa"),
  ]);
};

const buildContacts: SectionBuilder = (mix) => {
  const present = CONTACT_KEYS.filter((key) => !isMissingModule(mix[key]));
  const parts = present.flatMap((key): (SectionPart | null)[] => [
    { title: labelFor(key), value: toGenericValue(mix[key], key), collapsed: false },
    noteOf(mix, key),
  ]);
  return build("contatos", present, parts);
};

const buildQueries: SectionBuilder = (mix) => {
  const data = dataOf(mix, "consultas");
  if (!data) return null;
  return build("consultas", ["consultas"], [
    { title: null, value: toGenericValue(data, "consultas"), collapsed: false },
    noteOf(mix, "consultas"),
  ]);
};

// Ordem da spec §3.2.
export const SECTION_BUILDERS: readonly SectionBuilder[] = [
  buildScore,
  buildSmart,
  buildScr,
  buildIncome,
  buildRestrictions,
  buildPessoa,
  buildContacts,
  buildQueries,
];
