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
      <CardHeader className="flex flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-xl">Saldo</CardTitle>
        {children}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-muted-foreground">Disponível</p>
          <p className="text-3xl font-bold">{formatCurrency(Number(wallet.available))}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Reservado</p>
          <p className="text-3xl font-bold">{formatCurrency(Number(wallet.reserved))}</p>
        </div>
      </CardContent>
    </Card>
  );
}
