"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestTopupAction } from "@/actions/wallet-topup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseTopupInput } from "@/lib/wallet/topup-input";
import type { PixChargeStatus } from "@/lib/wallet/pix-charges";

const POLL_MS = 5000;

const STATUS_LABEL: Record<Exclude<PixChargeStatus, "pending">, string> = {
  paid: "Pago",
  expired: "Expirado",
  cancelled: "Cancelado",
};

interface Charge {
  id: string;
  pixPayload: string;
  qrImageBase64: string;
}

interface TopupDialogProps {
  // Estado efetivo das cobranças recentes, vindo do servidor a cada router.refresh().
  charges: { id: string; status: PixChargeStatus }[];
}

export function TopupDialog({ charges }: TopupDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [charge, setCharge] = useState<Charge | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const status: PixChargeStatus = charge ? (charges.find((c) => c.id === charge.id)?.status ?? "pending") : "pending";
  const polling = open && charge !== null && status === "pending";

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, router]);

  useEffect(() => {
    if (open && !charge) inputRef.current?.focus();
  }, [open, charge]);

  const close = () => {
    setOpen(false);
    setCharge(null);
    setValue("");
    setError(null);
    setCopied(false);
    openerRef.current?.focus();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseTopupInput(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await requestTopupAction({ amount: parsed.amount });
      if (res.error || !res.id || !res.pixPayload) {
        setError(res.error ?? "Não foi possível gerar o PIX. Tente novamente.");
        return;
      }
      setCharge({ id: res.id, pixPayload: res.pixPayload, qrImageBase64: res.qrImageBase64 ?? "" });
    });
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
      <Button ref={openerRef} onClick={() => setOpen(true)}>
        Recarregar
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onKeyDown={(e) => e.key === "Escape" && close()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-title"
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-6 shadow-lg"
          >
            <h2 id="topup-title" className="text-lg font-semibold">
              Recarregar carteira
            </h2>
            {!charge ? (
              <form onSubmit={submit} className="space-y-4" noValidate>
                <div className="space-y-2">
                  <Label htmlFor="topup-amount">Valor (R$ 10,00 a R$ 5.000,00)</Label>
                  <Input
                    id="topup-amount"
                    ref={inputRef}
                    inputMode="decimal"
                    placeholder="0,00"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={isPending}
                    aria-invalid={error !== null}
                    aria-describedby={error ? "topup-error" : undefined}
                  />
                  {error && (
                    <p id="topup-error" role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={close} disabled={isPending}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={isPending || value === ""}>
                    {isPending ? "Gerando PIX..." : "Gerar PIX"}
                  </Button>
                </div>
              </form>
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
                    <div className="space-y-2">
                      <Label htmlFor="topup-code">PIX copia e cola</Label>
                      <Input id="topup-code" readOnly value={charge.pixPayload} onFocus={(e) => e.target.select()} />
                      <Button type="button" variant="outline" size="sm" onClick={copy}>
                        {copied ? "Copiado" : "Copiar código"}
                      </Button>
                      {error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                    </div>
                    <p role="status" className="text-sm text-muted-foreground">
                      Aguardando pagamento...
                    </p>
                  </>
                ) : (
                  <p role="status" className="text-center text-lg font-semibold">
                    {STATUS_LABEL[status]}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button type="button" variant="outline" onClick={close}>
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
