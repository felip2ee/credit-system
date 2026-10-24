import type { WithdrawalStatus } from "@/lib/affiliates/withdrawals";

// Pagar ou cancelar só vale para saque aberto; os outros estados são finais.
export function canActOnWithdrawal(status: WithdrawalStatus): boolean {
  return status === "open";
}
