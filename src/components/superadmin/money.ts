import { moneySchema } from "@/lib/validators/catalog";

/** Mensagem de erro de um valor em reais (string decimal), ou null se válido. */
export function moneyError(value: string): string | null {
  const parsed = moneySchema.safeParse(value.trim().replace(",", "."));
  return parsed.success ? null : parsed.error.issues[0].message;
}

/** Normaliza a entrada (vírgula vira ponto) para a string decimal enviada à action. */
export function normalizeMoney(value: string): string {
  return value.trim().replace(",", ".");
}

/** Só para exibição; a regra de dinheiro nunca usa este número. */
export function formatBRL(value: string): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value));
}
