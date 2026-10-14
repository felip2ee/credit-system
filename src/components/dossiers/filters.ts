import type { DossierKindFilter } from "@/lib/dossiers/queries";

const PARAM_TO_KIND: Record<string, DossierKindFilter> = {
  pf: "PF",
  pj: "PJ",
  "pj-completo": "PJ_FULL",
};

const KIND_TO_PARAM: Record<DossierKindFilter, string> = {
  PF: "pf",
  PJ: "pj",
  PJ_FULL: "pj-completo",
};

export function parseDossierFilter(tipo: string | undefined): DossierKindFilter | undefined {
  return tipo && Object.hasOwn(PARAM_TO_KIND, tipo) ? PARAM_TO_KIND[tipo] : undefined;
}

export function dossierFilterParam(kind: DossierKindFilter | undefined): string | undefined {
  return kind ? KIND_TO_PARAM[kind] : undefined;
}
