"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestClientTopupAction } from "@/actions/credits-topup";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { failureMessage } from "@/lib/ui/failure-message";
import type { TopupSuggestion } from "@/lib/validators/wallet";
import { CREDITS_PATH } from "@/lib/wallet/credits-path";
import { parseTopupInput } from "@/lib/wallet/topup-input";
import { formatCurrency } from "@/lib/utils";

function TopupFailure({ what }: { what: string }) {
  const msg = failureMessage({ what, money: "not_charged", next: "Confira o valor e tente de novo." });
  return (
    <StatusBanner
      tone="attention"
      title={msg.title}
      description={
        <>
          <p>{msg.money}</p>
          <p>{msg.next}</p>
        </>
      }
    />
  );
}

export function ClientTopupDialog({ suggestions }: { suggestions: TopupSuggestion[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setValue("");
    setError(null);
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
      if (res.error || !res.id) {
        setError(res.error ?? "Não foi possível gerar o PIX. Tente novamente.");
        return;
      }
      // O QR abre na página, pela URL: sobrevive a re-render e remontagem deste diálogo.
      close();
      router.push(`${CREDITS_PATH}?pix=${res.id}`);
    });
  };

  return (
    <>
      <Button variant="onBrand" size="lg" onClick={() => setOpen(true)}>
        Recarregar
      </Button>
      <Dialog open={open} onClose={close} title="Recarregar créditos" dismissible={!isPending}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Valores sugeridos">
                {suggestions.map((s) => (
                  <Button
                    key={s.pfCount}
                    type="button"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => setValue(s.amount.replace(".", ","))}
                  >
                    {s.pfCount} PF · {formatCurrency(Number(s.amount))}
                  </Button>
                ))}
              </div>
            )}
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
              <div id="topup-error">
                <TopupFailure what={error} />
              </div>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" glow disabled={isPending || value === ""}>
              {isPending ? "Gerando PIX..." : "Gerar PIX"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
