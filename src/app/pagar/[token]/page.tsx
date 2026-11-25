import { Button } from "@/components/ui/button";
import { PublicShell } from "@/components/portal/public-shell";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { getOrCreateLinkPixCharge, type LinkPixResult } from "@/lib/payment-links/pix";
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

const PIX_ERRORS = {
  in_progress: "Estamos gerando o Pix. Aguarde alguns segundos e atualize a página.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
  amount_out_of_range: "Este valor não pode ser pago por Pix neste link.",
  unavailable: "Este link de pagamento não está disponível.",
  failed: "Não foi possível gerar o Pix agora. Tente de novo em instantes.",
} as const;

// O Pix só nasce com o clique ("?pix=1"): prévia de link (WhatsApp) e robôs abrem a página sem criar cobrança.
export default async function PaymentLinkPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { pix?: string };
}) {
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
        <PixSection pix={searchParams.pix === "1" ? await getOrCreateLinkPixCharge(resolved.link.id) : null} />
      </div>
    </PublicShell>
  );
}

function PixSection({ pix }: { pix: LinkPixResult | null }) {
  if (!pix) {
    return (
      <form method="get" className="text-center">
        <input type="hidden" name="pix" value="1" />
        <Button type="submit" size="lg">
          Pagar com Pix
        </Button>
      </form>
    );
  }
  if (!pix.ok) return <StatusBanner tone="neutral" title={PIX_ERRORS[pix.reason]} />;
  return (
    <Card>
      <CardContent className="space-y-4 p-6 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pix.qrDataUrl} alt="QR Code do Pix" className="mx-auto size-52" />
        <p className="text-sm text-muted-foreground">Pix copia e cola</p>
        <textarea
          readOnly
          rows={4}
          value={pix.pixPayload}
          aria-label="Pix copia e cola"
          className="w-full rounded-md border bg-muted p-3 text-xs"
        />
        <p className="text-sm text-muted-foreground">
          Pague no app do seu banco. Este código vale por 30 minutos e esta página não confirma o pagamento sozinha.
        </p>
      </CardContent>
    </Card>
  );
}
