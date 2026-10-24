"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestClientTopupAction } from "@/actions/credits-topup";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { CLIENT_TOPUP_SUGGESTIONS } from "@/lib/validators/wallet";
import { parseTopupInput } from "@/lib/wallet/topup-input";
import { formatCurrency } from "@/lib/utils";
import type { PixChargeStatus } from "@/lib/wallet/pix-charges";

const POLL_MS = 5000;
// Depois disto o polling para e o operador usa "Atualizar".
const POLL_MAX_MS = 10 * 60 * 1000;

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
}

interface ClientTopupDialogProps {
  // Estado efetivo das cobranças recentes, vindo do servidor a cada router.refresh().
  charges: { id: string; status: PixChargeStatus }[];
}

export function ClientTopupDialog({ charges }: ClientTopupDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [charge, setCharge] = useState<Charge | null>(null);
  const [copied, setCopied] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const status: PixChargeStatus = charge
    ? (charges.find((c) => c.id === charge.id)?.status ?? "pending")
    : "pending";
  const polling =
    open && charge !== null && status === "pending" && !pollExpired;

  useEffect(() => {
    if (!polling) return;
    // Aba oculta não consulta: o servidor não é chamado à toa.
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, POLL_MS);
    const stop = setTimeout(() => setPollExpired(true), POLL_MAX_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
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
    setPollExpired(false);
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
      const res = await requestClientTopupAction({ amount: parsed.amount });
      if (res.error || !res.id || !res.pixPayload) {
        setError(res.error ?? "Não foi possível gerar o PIX. Tente novamente.");
        return;
      }
      setCharge({
        id: res.id,
        pixPayload: res.pixPayload,
        qrImageBase64: res.qrImageBase64 ?? "",
      });
    });
  };

  const copy = async () => {
    if (!charge) return;
    try {
      await navigator.clipboard.writeText(charge.pixPayload);
      setCopied(true);
      setError(null);
    } catch {
      setCopied(false);
      setError(
        "Não foi possível copiar. Selecione o código e copie manualmente.",
      );
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>Recarregar</Button>
      <Dialog
        open={open}
        onClose={close}
        title="Recarregar créditos"
        dismissible={!isPending}
      >
        {!charge ? (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Valores sugeridos"
              >
                {CLIENT_TOPUP_SUGGESTIONS.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => setValue(s.replace(".", ","))}
                  >
                    {formatCurrency(Number(s))}
                  </Button>
                ))}
              </div>
              <Label htmlFor="topup-amount">
                Valor (R$ 10,00 a R$ 5.000,00)
              </Label>
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
                <p id="topup-error" role="alert" className="text-base text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={isPending}
              >
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
                    className="mx-auto size-52"
                  />
                )}
                <div className="space-y-2">
                  <Label htmlFor="topup-code">PIX copia e cola</Label>
                  <Input
                    id="topup-code"
                    readOnly
                    value={charge.pixPayload}
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={copy}
                  >
                    {copied ? "Copiado" : "Copiar código"}
                  </Button>
                  {error && <StatusBanner tone="attention" title={error} />}
                </div>
                <StatusBanner
                  tone={pollExpired ? "neutral" : "waiting"}
                  title={pollExpired ? "Atualização automática pausada." : "Aguardando pagamento..."}
                  description={pollExpired ? undefined : "Assim que o PIX for pago, seu saldo é atualizado."}
                />
                {pollExpired && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPollExpired(false);
                      router.refresh();
                    }}
                  >
                    Atualizar
                  </Button>
                )}
              </>
            ) : (
              <StatusBanner
                tone={status === "paid" ? "success" : status === "refunded" ? "attention" : "neutral"}
                title={STATUS_LABEL[status]}
                description={status === "expired" ? "Se o PIX for pago depois, o valor ainda será creditado." : undefined}
              />
            )}
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={close}>
                Fechar
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
