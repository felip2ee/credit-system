import { PublicShell } from "@/components/portal/public-shell";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { resolvePaymentLink } from "@/lib/payment-links/queries";
import { formatCurrency } from "@/lib/utils";

// O token está na URL: sem indexação e sem Referer.
export const metadata = {
  title: "Pagamento — Rainha Cred",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export const dynamic = "force-dynamic";

// Mensagem igual para link desconhecido, cancelado ou vencido: a página não revela se o token existiu.
const NEUTRAL = {
  invalid: "Este link de pagamento não está disponível.",
  expired: "Este link de pagamento não está disponível.",
  paid: "Este pagamento já foi concluído.",
} as const;

export default async function PaymentLinkPage({ params }: { params: { token: string } }) {
  const resolved = await resolvePaymentLink(params.token);

  if (!resolved.ok) {
    return (
      <PublicShell width="3xl">
        <StatusBanner
          tone={resolved.reason === "paid" ? "success" : "neutral"}
          title={NEUTRAL[resolved.reason]}
          description="Se precisar de ajuda, fale com quem enviou o link."
        />
      </PublicShell>
    );
  }

  const { summary } = resolved;
  return (
    <PublicShell width="3xl">
      <div className="space-y-6">
        <h1 className="text-center text-3xl font-bold">Pagamento da consulta</h1>
        <Card>
          <CardContent className="space-y-2 p-6 text-lg">
            <p>{summary.bureauName}</p>
            <p>{summary.productName}</p>
            <p>Titular: {summary.maskedDocument}</p>
            <p className="text-2xl font-bold">{formatCurrency(Number(summary.amount))}</p>
          </CardContent>
        </Card>
        {/* Pix pendente de decisão (T4 BLOCKED): nenhuma cobrança é criada aqui. */}
        <StatusBanner
          tone="neutral"
          title="O pagamento por Pix ainda não está disponível neste link."
          description="Fale com quem enviou o link."
        />
      </div>
    </PublicShell>
  );
}
