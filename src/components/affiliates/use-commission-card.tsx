import Link from "next/link";

import { ConvertForm } from "@/components/affiliates/convert-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PayoutMethod } from "@/lib/affiliates/types";
import { formatCurrency, formatPercent } from "@/lib/utils";

interface UseCommissionCardProps {
  method: PayoutMethod;
  available: string;
  fee: { fixed: string; percent: string } | null;
}

// Depende do saldo da carteira Pix: no modo Asaas o repasse sai pelo split, então o cartão não existe.
export function UseCommissionCard({ method, available, fee }: UseCommissionCardProps) {
  if (method !== "pix" || Number(available) <= 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usar a comissão</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConvertForm available={available} />
        {fee ? (
          <>
            <p className="text-muted-foreground">
              Taxa de saque: {formatCurrency(Number(fee.fixed))} + {formatPercent(fee.percent)}
            </p>
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <Link href="/portal/afiliacao/saque">Sacar por PIX</Link>
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Saque disponível em breve.</p>
        )}
      </CardContent>
    </Card>
  );
}
