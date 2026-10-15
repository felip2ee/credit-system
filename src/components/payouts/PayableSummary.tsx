import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export function PayableSummary({ balance }: { balance: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Valor a receber</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{formatCurrency(Number(balance))}</p>
        <p className="text-sm text-muted-foreground">
          Soma dos acréscimos, estornos e repasses já pagos. A plataforma repassa este valor ao Bureau.
        </p>
      </CardContent>
    </Card>
  );
}
