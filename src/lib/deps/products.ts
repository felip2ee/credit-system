// Nomes dos produtos da deps usados em todo o app (armazenados em queries.product
// e usados para casar o identificador real retornado no login da deps).
// Fonte única — antes estavam duplicados como string literal em vários arquivos.
// Podem ser sobrescritos por conta via env DEPS_PRODUTO_PF / DEPS_PRODUTO_PJ.

import type { EntityKind } from "@/types/app";

export const DEPS_PRODUCT_PF = "Smart PF 002";
export const DEPS_PRODUCT_PJ = "Smart PJ 010";

export function depsProductName(type: EntityKind): string {
  return type === "PF" ? DEPS_PRODUCT_PF : DEPS_PRODUCT_PJ;
}
