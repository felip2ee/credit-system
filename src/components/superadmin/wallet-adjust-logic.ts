import { formatCurrency } from "@/lib/utils";

// Frase por extenso do ajuste, para a confirmação. Recebe o valor já normalizado ("-10.50").
export function describeAdjustment(normalized: string): string {
  const isDebit = normalized.startsWith("-");
  const amount = formatCurrency(Math.abs(Number(normalized)));
  return isDebit ? `Débito de ${amount} da carteira` : `Crédito de ${amount} na carteira`;
}
