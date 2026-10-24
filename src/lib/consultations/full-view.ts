// Visão completa da consulta: 100% do mix bruto da DEPS em seções tipadas, blocos genéricos,
// módulos ausentes e rodapé. Função pura; nada de banco nem React.

import { extractMix } from "@/lib/deps/adapter";
import { META_KEYS, isMissingModule, isRecord } from "@/lib/deps/payload-shape";
import type { CanonicalBureauResult } from "@/types/bureau";
import type { FullConsultationView, GenericField } from "@/types/consultation-view";
import { toGenericBlock, toGenericValue } from "./generic-block";
import { SECTION_BUILDERS, scoreValueOf } from "./full-view-sections";
import { labelFor } from "./labels";
import { toConsultationView, type ConsultationView } from "./view-model";

export { FULL_SECTION_TITLES } from "./full-view-sections";

export const FULL_DATA_UNAVAILABLE = "Dados completos não disponíveis.";

// Rodapé: META_KEYS presentes no mix, depois as chaves da raiz fora do mix (ex.: consultasComplementares).
function metaFields(payload: unknown, mix: Record<string, unknown>): GenericField[] {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const rootExtras = isRecord(root) && isRecord(root.mix) ? Object.entries(root).filter(([key]) => key !== "mix") : [];
  const footer = META_KEYS.filter((key) => Object.hasOwn(mix, key)).map((key): [string, unknown] => [key, mix[key]]);
  return [...footer, ...rootExtras].map(([key, value]) => ({ key, label: labelFor(key), value: toGenericValue(value, key) }));
}

// null quando o payload não tem mix utilizável (null, não-objeto, ou mix sem chaves).
export function toFullConsultationView(payload: unknown): FullConsultationView | null {
  const mix = extractMix(payload);
  if (!mix || Object.keys(mix).length === 0) return null;

  const sections = SECTION_BUILDERS.flatMap((build) => build(mix) ?? []);
  const consumed = new Set(sections.flatMap((section) => section.sources));
  const view: FullConsultationView = {
    sections,
    generic: [],
    missing: [],
    meta: metaFields(payload, mix),
    scoreValue: scoreValueOf(mix),
  };
  for (const [key, value] of Object.entries(mix)) {
    if (META_KEYS.includes(key) || consumed.has(key)) continue;
    if (isMissingModule(value)) view.missing.push({ key, label: labelFor(key) });
    else view.generic.push(toGenericBlock(key, value));
  }
  return view;
}

export interface ConsultationContent {
  full: FullConsultationView | null;
  view: ConsultationView | null;
}

// `full` vem do payload bruto; `view` (canônico) é o fallback quando o payload não existe ou não tem mix.
export function toConsultationContent(payload: unknown, canonical: CanonicalBureauResult | null): ConsultationContent {
  return {
    full: toFullConsultationView(payload),
    view: canonical ? toConsultationView(canonical) : null,
  };
}
