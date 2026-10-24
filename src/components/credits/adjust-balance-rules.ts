import { formatCurrency } from "@/lib/utils";
import { toCents } from "@/lib/catalog/money";
import { moneyError, normalizeMoney } from "@/lib/catalog/money-input";

export const REASON_MIN = 5;
export const REASON_MAX = 500;

export type AdjustDirection = "credit" | "debit";

interface AdjustmentDraft {
  direction: AdjustDirection;
  amount: string;
  reason: string;
  // Saldos em reais, como string decimal vinda do banco ("150.00").
  bureauAvailable: string;
  // Máximo para remover: o menor entre o que o Bureau creditou ao cliente (líquido) e o disponível do cliente.
  maxDebit: string;
}

const balanceCents = (value: string): number => Math.round(Number(value) * 100);

export function canSubmitAdjustment(draft: AdjustmentDraft): { ok: boolean; message: string | null } {
  const reasonLength = draft.reason.trim().length;
  if (reasonLength < REASON_MIN || reasonLength > REASON_MAX) {
    return { ok: false, message: `Informe o motivo, de ${REASON_MIN} a ${REASON_MAX} caracteres.` };
  }
  const amountMessage = moneyError(draft.amount);
  if (amountMessage) return { ok: false, message: amountMessage };
  const cents = toCents(normalizeMoney(draft.amount));
  if (draft.direction === "credit" && cents > balanceCents(draft.bureauAvailable)) {
    return { ok: false, message: "Saldo da carteira do Bureau insuficiente." };
  }
  if (draft.direction === "debit" && cents > balanceCents(draft.maxDebit)) {
    return {
      ok: false,
      message: `O Bureau só pode remover o que ele mesmo creditou a este cliente (máximo ${formatCurrency(Number(draft.maxDebit))}).`,
    };
  }
  return { ok: true, message: null };
}
