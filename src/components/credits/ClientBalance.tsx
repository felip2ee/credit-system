import { BalanceCard } from "@/components/ui/balance-card";
import type { ClientWalletBalance } from "@/lib/wallet/client-queries";
import { formatCurrency } from "@/lib/utils";

interface ClientBalanceProps {
  wallet: ClientWalletBalance;
  // Ação principal do cartão (botão "Recarregar" ou aviso).
  children?: React.ReactNode;
}

export function ClientBalance({ wallet, children }: ClientBalanceProps) {
  return (
    <BalanceCard
      label="Saldo disponível"
      value={formatCurrency(Number(wallet.available))}
      hideable
      hint={`Reservado em pedidos: ${formatCurrency(Number(wallet.reserved))}`}
      action={children}
    />
  );
}
