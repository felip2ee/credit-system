import { normalizeMoney } from "@/lib/catalog/money-input";
import { topupAmountSchema } from "@/lib/validators/wallet";

export type TopupInput = { ok: true; amount: string } | { ok: false; error: string };

/** Converte a entrada em reais (vírgula decimal) na string enviada à action, ou devolve o erro. */
export function parseTopupInput(value: string): TopupInput {
  const amount = normalizeMoney(value);
  const parsed = topupAmountSchema.safeParse(amount);
  return parsed.success ? { ok: true, amount } : { ok: false, error: parsed.error.issues[0].message };
}
