"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";

import { requestTopupAction } from "@/actions/wallet-topup";
import { Button } from "@/components/ui/button";
import { CheckoutForm } from "@/components/payments/CheckoutForm";
import { Dialog } from "@/components/ui/dialog";
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
      <Dialog open={open} onClose={close} title="Recarregar carteira" className="max-h-[92vh] max-w-lg overflow-y-auto">
        {!charge ? (
          <CheckoutForm scope="bureau" action={requestTopupAction} onClose={close} onPix={setCharge} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              {status === "pending" ? (
                <p className="text-sm text-muted-foreground">Passo final: pagar o Pix</p>
              ) : (
                <p role="status" className="font-semibold">
                  {STATUS_LABEL[status]}
                </p>
              )}
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Fechar"
                className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {status === "pending" ? (
              <>
                {charge.summary && (
                  <div className="text-center" aria-live="polite">
                    <p className="text-sm text-muted-foreground">Valor a pagar</p>
                    <p className="text-2xl font-bold">{formatCents(charge.summary.totalCents)}</p>
                    {pixQrNote(charge.summary) && <p className="text-xs text-muted-foreground">{pixQrNote(charge.summary)}</p>}
                  </div>
                )}
                <p className="text-base">O que acontece depois: pague este Pix no app do seu banco. O saldo da carteira sobe sozinho quando o pagamento for confirmado.</p>
                {charge.qrImageBase64 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`data:image/png;base64,${charge.qrImageBase64}`} alt="QR Code do PIX" className="mx-auto aspect-square w-48 max-w-full" />
                )}
                <div className="space-y-2">
                  <Label htmlFor="topup-code">PIX copia e cola</Label>
                  <Input id="topup-code" readOnly value={charge.pixPayload} onFocus={(e) => e.target.select()} />
                  <Button type="button" variant="outline" size="sm" onClick={copy}>
                    {copied ? "Copiado" : "Copiar código"}
                  </Button>
                  {error && <StatusBanner tone="danger" title={error} />}
                </div>
                <p role="status" className="text-sm text-muted-foreground">
                  Aguardando pagamento...
                </p>
              </>
            ) : (
              status === "expired" && (
                <p className="text-sm text-muted-foreground">Se o PIX for pago depois, o valor ainda será creditado.</p>
              )
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
