"use client";

import { formatCents, pixQrNote } from "@/components/payments/checkout-summary";
import type { ChargeSummary } from "@/lib/wallet/pix-fees";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { CREDITS_PATH } from "@/lib/wallet/credits-path";

const POLL_MS = 5000;

interface PendingChargeButtonProps {
  pixPayload: string;
  summary?: ChargeSummary;
  // Abre já na carga da página: é o PIX recém-gerado (?pix=<id>).
  defaultOpen?: boolean;
}

// PIX de uma cobrança pendente: o QR é refeito a partir do código copia e cola guardado.
export function PendingChargeButton({ pixPayload, summary, defaultOpen = false }: PendingChargeButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    QRCode.toDataURL(pixPayload, { margin: 1, width: 208 })
      .then((url) => active && setQr(url))
      .catch(() => active && setQr(null));
    return () => {
      active = false;
    };
  }, [open, pixPayload]);

  // Com o diálogo aberto, confere o pagamento: a linha sai de "pendente" quando o Asaas avisa.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, router]);

  const close = () => {
    setOpen(false);
    if (defaultOpen) router.replace(CREDITS_PATH);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pixPayload);
      setCopied(true);
      setError(null);
    } catch {
      setCopied(false);
      setError("Não foi possível copiar. Selecione o código e copie manualmente.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-full font-bold text-primary underline sm:w-auto"
      >
        Ver QR Code
      </button>
      <Dialog open={open} onClose={close} title="PIX aguardando pagamento">
        <div className="space-y-4">
          {summary && (
            <div className="text-center" aria-live="polite">
              <p className="text-sm text-muted-foreground">Valor a pagar</p>
              <p className="text-2xl font-bold">{formatCents(summary.totalCents)}</p>
              {pixQrNote(summary) && <p className="text-xs text-muted-foreground">{pixQrNote(summary)}</p>}
            </div>
          )}
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR Code do PIX" className="mx-auto size-52" />
          )}
          <div className="space-y-2">
            <Label htmlFor="pending-pix-code">PIX copia e cola</Label>
            <Input id="pending-pix-code" readOnly value={pixPayload} onFocus={(e) => e.target.select()} />
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? "Copiado" : "Copiar código"}
            </Button>
            {error && <StatusBanner tone="attention" title={error} />}
          </div>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={close}>
              Fechar
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
