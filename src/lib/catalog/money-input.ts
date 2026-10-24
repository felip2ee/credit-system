import { moneySchema, nonNegativeMoneySchema } from "@/lib/validators/catalog";

// Milhar pt-BR só vale quando há vírgula decimal: "1.234,50" -> "1234.50".
// "12.50" fica como está (ponto decimal); "1.234" e "1.234.50" são ambíguos e o validador rejeita.
const THOUSANDS_BEFORE_COMMA = /^(\d{1,3}(?:\.\d{3})+),/;

/** Normaliza a entrada do usuário para a string decimal enviada à action. */
export function normalizeMoney(value: string): string {
  return value
    .trim()
    .replace(THOUSANDS_BEFORE_COMMA, (_, int: string) => `${int.replace(/\./g, "")},`)
    .replace(",", ".");
}

/** Mensagem de erro de um valor em reais, ou null se válido. */
export function moneyError(value: string): string | null {
  const parsed = moneySchema.safeParse(normalizeMoney(value));
  return parsed.success ? null : parsed.error.issues[0].message;
}

/** Como moneyError, mas aceita 0,00: custo e valor por sócio valem a partir de zero. */
export function nonNegativeMoneyError(value: string): string | null {
  const parsed = nonNegativeMoneySchema.safeParse(normalizeMoney(value));
  return parsed.success ? null : parsed.error.issues[0].message;
}
