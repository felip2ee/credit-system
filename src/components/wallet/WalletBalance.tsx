import { Card } from "@/components/ui/card";
import type { WalletBalance as WalletBalanceData } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";

export function WalletBalance({ wallet, children }: { wallet: WalletBalanceData; children?: React.ReactNode }) {
  const reserved = Number(wallet.reserved);
  return (
    <div className="space-y-3">
      <Card variant="hero" className="space-y-1 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base">Saldo pré-pago</h2>
          {children}
        </div>
        <p className="text-3xl font-bold md:text-4xl leading-tight tabular-nums">{formatCurrency(Number(wallet.available))}</p>
        <p className="text-base">Dinheiro que você colocou na carteira. Pode ser usado agora em novos pedidos.</p>
      </Card>
      {reserved > 0 && (
        <Card className="space-y-1 p-4 md:p-5">
          <h2 className="text-base text-muted-foreground">Reservado em pedidos em andamento</h2>
          <p className="text-xl font-bold md:text-2xl leading-tight tabular-nums">{formatCurrency(reserved)}</p>
          <p className="text-base text-muted-foreground">Este valor volta ao saldo se o pedido for cancelado.</p>
        </Card>
      )}
    </div>
  );
}
