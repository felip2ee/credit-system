import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientWalletBalance } from "@/lib/wallet/client-queries";
import { formatCurrency } from "@/lib/utils";

interface ClientBalanceProps {
  wallet: ClientWalletBalance;
  children?: React.ReactNode;
}

export function ClientBalance({ wallet, children }: ClientBalanceProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Saldo</CardTitle>
        {children}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm text-muted-foreground">Disponível</p>
          <p className="text-2xl font-semibold">{formatCurrency(Number(wallet.available))}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Reservado</p>
          <p className="text-2xl font-semibold">{formatCurrency(Number(wallet.reserved))}</p>
        </div>
      </CardContent>
    </Card>
  );
}
