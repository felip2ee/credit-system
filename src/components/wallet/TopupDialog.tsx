"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { requestTopupAction } from "@/actions/wallet-topup";
import { Button } from "@/components/ui/button";
import { CheckoutForm } from "@/components/payments/CheckoutForm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents, pixQrNote } from "@/components/payments/checkout-summary";
import type { ChargeSummary } from "@/lib/wallet/pix-fees";
import type { PixChargeStatus } from "@/lib/wallet/pix-charges";
import { StatusBanner } from "@/components/ui/status-banner";

const POLL_MS = 5000;

const STATUS_LABEL: Record<Exclude<PixChargeStatus, "pending">, string> = {
  paid: "Pago",
  expired: "Expirado",
  cancelled: "Cancelado",
  refunded: "Estornado",
};

interface Charge {
  id: string;
  pixPayload: string;
  qrImageBase64: string;
  summary?: ChargeSummary;
}

interface TopupDialogProps {
  // Estado efetivo das cobranças recentes, vindo do servidor a cada router.refresh().
  charges: { id: string; status: PixChargeStatus }[];
}

export function TopupDialog({ charges }: TopupDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charge, setCharge] = useState<Charge | null>(null);
  const [copied, setCopied] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const status: PixChargeStatus = charge ? (charges.find((c) => c.id === charge.id)?.status ?? "pending") : "pending";
  const polling = open && charge !== null && status === "pending";

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, router]);

  // O formulário sai da árvore ao mostrar a cobrança: sem isto o foco cai no body e o Escape para de funcionar.
  useEffect(() => {
    if (charge) closeRef.current?.focus();
  }, [charge]);

  const close = () => {
    setOpen(false);
    setCharge(null);
    setError(null);
    setCopied(false);
    openerRef.current?.focus();
  };

  const copy = async () => {
    if (!charge) return;
    try {
      await navigator.clipboard.writeText(charge.pixPayload);
      setCopied(true);
    } catch {
      setError("Não foi possível copiar. Selecione o código e copie manualmente.");
    }
  };

  return (
    <>
      <Button ref={openerRef} variant="onBrand" onClick={() => setOpen(true)}>
        Recarregar
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          onKeyDown={(e) => e.key === "Escape" && close()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-title"
            className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-modal border border-border bg-card p-6 text-card-foreground shadow-lg"
          >
            <h2 id="topup-title" className="text-lg font-semibold">
              Recarregar carteira
            </h2>
            {!charge ? (
              <CheckoutForm scope="bureau" action={requestTopupAction} onClose={close} onPix={setCharge} />
            ) : (
              <div className="space-y-4">
                {status === "pending" ? (
                  <>
                    {charge.qrImageBase64 && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`data:image/png;base64,${charge.qrImageBase64}`}
                        alt="QR Code do PIX"
                        className="mx-auto h-48 w-48"
                      />
                    )}
                    {charge.summary && (
                      <div className="text-center" aria-live="polite">
                        <p className="text-sm text-muted-foreground">Valor a pagar</p>
                        <p className="text-2xl font-bold">{formatCents(charge.summary.totalCents)}</p>
                        {pixQrNote(charge.summary) && <p className="text-xs text-muted-foreground">{pixQrNote(charge.summary)}</p>}
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="topup-code">PIX copia e cola</Label>
                      <Input id="topup-code" readOnly value={charge.pixPayload} onFocus={(e) => e.target.select()} />
                      <Button type="button" variant="outline" size="sm" onClick={copy}>
                        {copied ? "Copiado" : "Copiar código"}
                      </Button>
                      {error && (
                        <StatusBanner tone="danger" title={error} />
                      )}
                    </div>
                    <p role="status" className="text-sm text-muted-foreground">
                      Aguardando pagamento...
                    </p>
                  </>
                ) : (
                  <div role="status" className="space-y-1 text-center">
                    <p className="text-lg font-semibold">{STATUS_LABEL[status]}</p>
                    {status === "expired" && (
                      <p className="text-sm text-muted-foreground">
                        Se o PIX for pago depois, o valor ainda será creditado.
                      </p>
                    )}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button ref={closeRef} type="button" variant="outline" onClick={close}>
                    Fechar
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
