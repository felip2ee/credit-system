import { formatCurrency } from "@/lib/utils";

interface HowItWorksProps {
  fee: { fixed: string; percent: string } | null;
}

export function HowItWorks({ fee }: HowItWorksProps) {
  const feeText = fee ? `com taxa de ${formatCurrency(Number(fee.fixed))} + ${fee.percent}%` : "com taxa";
  const steps = [
    "Compartilhe seu link de afiliado.",
    "A pessoa se cadastra e confirma o celular.",
    "Quando ela faz uma pesquisa, você ganha uma parte do lucro do Bureau.",
    "A comissão fica em carência por alguns dias. Depois, fica disponível.",
    `Converta em créditos ou saque por PIX, ${feeText}.`,
  ];

  return (
    <details open className="rounded-lg border bg-card p-4">
      <summary className="cursor-pointer text-lg font-bold">Como funciona</summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-3 text-muted-foreground">Se o pedido for estornado, a comissão é desfeita.</p>
    </details>
  );
}
