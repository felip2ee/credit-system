import type { PayoutMethod } from "@/lib/affiliates/types";
import { formatCurrency, formatPercent } from "@/lib/utils";

interface HowItWorksProps {
  fee: { fixed: string; percent: string } | null;
  // Como o afiliado recebe: o texto muda, porque o modo Asaas não tem carência, conversão nem saque.
  method: PayoutMethod;
}

export function HowItWorks({ fee, method }: HowItWorksProps) {
  const feeText = fee ? `com taxa de ${formatCurrency(Number(fee.fixed))} + ${formatPercent(fee.percent)}` : "com taxa";
  const common = [
    "Compartilhe seu link de afiliado.",
    "A pessoa se cadastra e confirma o celular.",
    "Cada vez que ela recarrega créditos, você ganha uma comissão: uma porcentagem do valor líquido do pagamento (já sem a taxa do Asaas).",
  ];
  const steps =
    method === "asaas"
      ? [...common, "O Asaas paga a comissão direto na sua conta Asaas, no momento do pagamento. Não há carência nem pedido de saque."]
      : [
          ...common,
          "A comissão pode ficar em carência por alguns dias. Depois, fica disponível.",
          `Converta em créditos ou saque por PIX, ${feeText}.`,
        ];

  return (
    <details open className="rounded-lg border bg-card p-4">
      <summary className="cursor-pointer text-base font-semibold">Como funciona</summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-3 text-muted-foreground">
        {method === "asaas"
          ? "Se o pagamento for estornado, o Asaas desfaz a comissão."
          : "Se o pagamento for estornado, a comissão é desfeita."}
      </p>
    </details>
  );
}
