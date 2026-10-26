import { statusInfo } from "@/lib/ui/status";
import { formatCurrency } from "@/lib/utils";
import type { ClientLedgerEntry } from "@/lib/wallet/client-queries";

const KINDS: ClientLedgerEntry["kind"][] = [
  "topup",
  "reserve",
  "capture",
  "release",
  "reversal",
  "commission_credit",
  "adjustment_credit",
  "adjustment_debit",
];

// Rótulos vêm do vocabulário único (`@/lib/ui/status`).
export const CLIENT_KIND_LABEL = Object.fromEntries(
  KINDS.map((k) => [k, statusInfo("walletEntry", k, "client").label]),
) as Record<ClientLedgerEntry["kind"], string>;

// Só o ajuste mostra sinal: nos outros tipos o rótulo já diz o sentido do valor.
export function clientLedgerAmount(kind: ClientLedgerEntry["kind"], amount: string): string {
  const text = formatCurrency(Number(amount));
  if (kind === "adjustment_credit") return `+ ${text}`;
  if (kind === "adjustment_debit") return `- ${text}`;
  return text;
}
