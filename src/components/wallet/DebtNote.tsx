import { hasDebt } from "@/lib/wallet/payable-summary";
import { formatMoney } from "@/lib/wallet/money";

// Estorno que o lucro liberado não cobriu: some quando não há dívida.
export function DebtNote({ debt }: { debt: string }) {
  if (!hasDebt({ debt })) return null;
  return (
    <p className="text-base font-bold">
      Estorno a compensar: {formatMoney(debt)}. Será descontado dos próximos lucros.
    </p>
  );
}
