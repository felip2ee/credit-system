import { moneyError, nonNegativeMoneyError, normalizeMoney } from "@/lib/catalog/money-input";
import { commissionPctSchema } from "@/lib/validators/catalog";

/** Preço de venda é opcional: vazio = versão sem preço ("não à venda"). */
export function optionalPriceError(value: string): string | null {
  return value.trim() === "" ? null : moneyError(value);
}

/** Corpo do preço para a action: vazio vira null; o valor por sócio só vale no Dossiê Empresarial. */
export function buildSalePrices(salePrice: string, salePricePerPartner: string, hasPartner: boolean) {
  return {
    salePrice: salePrice.trim() === "" ? null : normalizeMoney(salePrice),
    salePricePerPartner: hasPartner ? normalizeMoney(salePricePerPartner.trim() || "0") : "0.00",
  };
}

export function partnerPriceError(value: string, hasPartner: boolean): string | null {
  return hasPartner ? nonNegativeMoneyError(value.trim() || "0") : null;
}

export type PctParse = { ok: true; value: number } | { ok: false; error: string };

/** Lê "20", "20,5" ou "20.5" como % de 0 a 99,99 com até 2 casas. */
export function parsePctInput(text: string): PctParse {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return { ok: false, error: "Informe a porcentagem." };
  const number = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
  const parsed = commissionPctSchema.safeParse(number);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues[0].message };
}

/** "20.00" -> "20"; "12.50" -> "12,5" (campo de edição em pt-BR). */
export function pctToInput(pct: string | null): string {
  return pct === null ? "" : String(Number(pct)).replace(".", ",");
}

export function formatPct(pct: string | null): string {
  return pct === null ? "—" : `${pctToInput(pct)}%`;
}
