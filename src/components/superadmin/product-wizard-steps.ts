// Lógica pura do assistente "Novo produto": validação por etapa e aviso de saída. Os valores são validados
// com as mesmas regras de antes (price-input e money-input); o código e o nome usam o schema da action.
import { nonNegativeMoneyError } from "@/lib/catalog/money-input";
import { productCreateSchema } from "@/lib/validators/catalog";

import { optionalPriceError, partnerPriceError } from "./price-input";

export const PARTNER_CODE = "dossie_empresarial";

export type ProductStepId = "identity" | "values";

export interface IdentityFields {
  code: string;
  name: string;
  depsProduct: string;
}

export interface ValuesFields {
  baseCost: string;
  baseCostPerPartner: string;
  salePrice: string;
  salePricePerPartner: string;
  hasPartner: boolean;
}

export type IdentityErrors = Partial<Record<keyof IdentityFields, string>>;
export type ValuesErrors = Partial<Record<Exclude<keyof ValuesFields, "hasPartner">, string>>;

const identitySchema = productCreateSchema.pick({ code: true, name: true, depsProduct: true });

export function identityErrors(fields: IdentityFields): IdentityErrors {
  const parsed = identitySchema.safeParse(fields);
  if (parsed.success) return {};
  const errors: IdentityErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof IdentityFields;
    errors[key] ??= issue.message;
  }
  return errors;
}

export function valuesErrors(fields: ValuesFields): ValuesErrors {
  const found: ValuesErrors = {
    baseCost: nonNegativeMoneyError(fields.baseCost) ?? undefined,
    baseCostPerPartner: fields.hasPartner ? (nonNegativeMoneyError(fields.baseCostPerPartner) ?? undefined) : undefined,
    salePrice: optionalPriceError(fields.salePrice) ?? undefined,
    salePricePerPartner: partnerPriceError(fields.salePricePerPartner, fields.hasPartner) ?? undefined,
  };
  return Object.fromEntries(Object.entries(found).filter(([, message]) => message !== undefined));
}

// Sair da tela perde o que foi digitado: só pede confirmação se há algo a perder.
export function hasTypedProductData(fields: IdentityFields & Omit<ValuesFields, "hasPartner">): boolean {
  return Object.values(fields).some((value) => value.trim() !== "");
}
