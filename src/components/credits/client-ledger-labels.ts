import { formatCurrency } from "@/lib/utils";
import type { ClientLedgerEntry } from "@/lib/wallet/client-queries";

export const CLIENT_KIND_LABEL: Record<ClientLedgerEntry["kind"], string> = {
  topup: "Recarga",
  reserve: "Reserva",
  capture: "Cobrança",
  release: "Liberação",
  reversal: "Estorno",
  commission_credit: "Comissão convertida",
  adjustment_credit: "Ajuste do Bureau (crédito)",
  adjustment_debit: "Ajuste do Bureau (débito)",
};

// Só o ajuste mostra sinal: nos outros tipos o rótulo já diz o sentido do valor.
export function clientLedgerAmount(kind: ClientLedgerEntry["kind"], amount: string): string {
  const text = formatCurrency(Number(amount));
  if (kind === "adjustment_credit") return `+ ${text}`;
  if (kind === "adjustment_debit") return `- ${text}`;
  return text;
}
