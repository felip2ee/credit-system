import { BalanceCard } from "@/components/ui/balance-card";
import type { AffiliateWallet, PayoutMethod } from "@/lib/affiliates/types";
import { formatCurrency } from "@/lib/utils";

interface AffiliateBalanceProps {
  method: PayoutMethod;
  wallet: AffiliateWallet;
  asaasReceived: { cents: number; reversalFailedCents: number };
}

// Pix: saldo do sistema e carência. Conta Asaas: o Asaas paga no recebimento, então não há saldo nem carência.
export function AffiliateBalance({ method, wallet, asaasReceived }: AffiliateBalanceProps) {
  if (method === "asaas") {
    return (
      <BalanceCard
        label="Recebido pelo Asaas"
        value={formatCurrency(asaasReceived.cents / 100)}
        hideable
        hint={
          asaasReceived.reversalFailedCents > 0 && (
            <p>
              Inclui <span className="font-bold tabular-nums">{formatCurrency(asaasReceived.reversalFailedCents / 100)}</span> de
              repasses estornados sem devolução
            </p>
          )
        }
      />
    );
  }
  return (
    <BalanceCard
      label="Comissão disponível"
      value={formatCurrency(Number(wallet.available))}
      hideable
      hint={<p>Em carência: <span className="font-bold tabular-nums">{formatCurrency(Number(wallet.pending))}</span></p>}
    />
  );
}
