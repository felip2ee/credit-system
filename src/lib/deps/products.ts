// Nomes dos produtos da deps usados em todo o app (gravados em consultations.product
// e usados para casar o identificador real retornado no login da deps).
// Fonte única — nenhum outro arquivo escreve estes literais.
// Podem ser sobrescritos por env DEPS_PRODUTO_PF / DEPS_PRODUTO_PJ.

import type { EntityKind } from "@/types/app";

export const DEPS_PRODUCT_PF = "Smart PF 002";
export const DEPS_PRODUCT_PJ = "Smart PJ 010";

export function depsProductName(type: EntityKind): string {
  const override = process.env[type === "PF" ? "DEPS_PRODUTO_PF" : "DEPS_PRODUTO_PJ"]?.trim();
  return override || (type === "PF" ? DEPS_PRODUCT_PF : DEPS_PRODUCT_PJ);
}
