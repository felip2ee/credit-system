// Renderizador genérico: qualquer valor do payload da DEPS vira GenericValue (texto, campos, tabela ou JSON).
// Documentos (cpf/cnpj/documento) saem sempre mascarados, em qualquer profundidade.

import { DOCUMENT_KEYS, isEnvelope, isRecord } from "@/lib/deps/payload-shape";
import { maskDocumentValue } from "@/lib/mask-document";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { GenericBlock, GenericValue } from "@/types/consultation-view";
import { labelFor } from "./labels";

const EMPTY = "—";
const MAX_FIELDS_DEPTH = 4;
const CURRENCY_KEY = /valor|total|limite|ticket|renda|gasto/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIDNIGHT = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const DATE_TIME_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const NUMBER_FORMAT = new Intl.NumberFormat("pt-BR");

type Row = Record<string, unknown>;

// Cópia do valor com todo cpf/cnpj/documento mascarado (usada nos fallbacks em JSON).
function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      DOCUMENT_KEYS.has(key) ? (item === null ? null : maskDocumentValue(item)) : maskDeep(item),
    ]),
  );
}

function formatString(value: string): string {
  if (value.trim() === "") return EMPTY;
  const date = DATE_ONLY.exec(value) ?? MIDNIGHT.exec(value);
  if (date) return `${date[3]}/${date[2]}/${date[1]}`;
  const time = DATE_TIME.exec(value);
  if (time) return `${time[3]}/${time[2]}/${time[1]} ${time[4]}:${time[5]}`;
  if (DATE_TIME_ZONE.test(value) && !Number.isNaN(new Date(value).getTime())) return formatDateTime(value);
  return value;
}

// A regra de documento vem antes de todas as outras, inclusive para números.
export function formatScalar(key: string, value: unknown): string {
  if (DOCUMENT_KEYS.has(key)) return value === null || value === undefined ? EMPTY : maskDocumentValue(value);
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return CURRENCY_KEY.test(key) ? formatCurrency(value) : NUMBER_FORMAT.format(value);
  if (typeof value === "string") return formatString(value);
  return JSON.stringify(maskDeep(value));
}

const text = (value: string): GenericValue => ({ kind: "text", text: value });
const json = (value: unknown): GenericValue => ({ kind: "json", text: JSON.stringify(maskDeep(value), null, 2) });
const isPrimitive = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

// Colunas nomeadas primeiro, na ordem dada; depois toda outra chave das linhas (união, ordem da primeira aparição).
export function toGenericTable(rows: Row[], columns: readonly string[] = []): GenericValue {
  const union = rows.flatMap((row) => Object.keys(row)).filter((key, index, all) => all.indexOf(key) === index);
  const keys = [...columns, ...union.filter((key) => !columns.includes(key))];
  return {
    kind: "table",
    columns: keys.map((key) => ({ key, label: labelFor(key) })),
    rows: rows.map((row) => keys.map((key) => formatScalar(key, Object.hasOwn(row, key) ? row[key] : undefined))),
  };
}

function arrayValue(items: unknown[], key: string): GenericValue {
  if (items.length === 0) return text("Nenhum");
  const rows = items.filter(isRecord);
  if (rows.length === items.length) return toGenericTable(rows);
  if (items.every(isPrimitive)) return text(items.map((item) => formatScalar(key, item)).join(", "));
  return json(items);
}

export function toGenericValue(value: unknown, key = "", depth = 1): GenericValue {
  if (isEnvelope(value)) {
    if (value.data !== null && value.data !== undefined) return toGenericValue(value.data, key, depth);
    return text(typeof value.message === "string" && value.message.trim() ? value.message : EMPTY);
  }
  const isContainer = Array.isArray(value) || isRecord(value);
  if (isContainer && depth > MAX_FIELDS_DEPTH) return json(value);
  if (Array.isArray(value)) return arrayValue(value, key);
  if (isRecord(value)) {
    return {
      kind: "fields",
      fields: Object.entries(value).map(([name, item]) => ({
        key: name,
        label: labelFor(name),
        value: toGenericValue(item, name, depth + 1),
      })),
    };
  }
  return text(formatScalar(key, value));
}

export function toGenericBlock(key: string, moduleValue: unknown): GenericBlock {
  const info = isEnvelope(moduleValue) ? formatScalar("info", moduleValue.info) : EMPTY;
  return {
    key,
    title: labelFor(key),
    note: info === EMPTY ? null : info,
    value: toGenericValue(moduleValue, key),
  };
}
