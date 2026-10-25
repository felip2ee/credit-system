import { Card } from "@/components/ui/card";
import type { WalletBalance as WalletBalanceData } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";

export function WalletBalance({ wallet, children }: { wallet: WalletBalanceData; children?: React.ReactNode }) {
  return (
    <Card variant="hero" className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Saldo</h2>
        {children}
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-base">Disponível</dt>
          <dd className="text-4xl font-bold leading-tight tabular-nums">{formatCurrency(Number(wallet.available))}</dd>
        </div>
        <div>
          <dt className="text-base">Reservado</dt>
          <dd className="text-2xl font-bold leading-tight tabular-nums">{formatCurrency(Number(wallet.reserved))}</dd>
        </div>
      </dl>
    </Card>
  );
}
