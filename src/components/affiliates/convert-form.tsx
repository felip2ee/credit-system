"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { convertCommissionAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatCurrency } from "@/lib/utils";

import { convertAmountError } from "./convert-rules";

interface ConvertFormProps {
  available: string;
}

export function ConvertForm({ available }: ConvertFormProps) {
  const router = useRouter();
  const [amount, setAmount] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  // Mesmo id em cliques repetidos: a conversão acontece uma vez. Novo id só depois do sucesso.
  const requestId = useRef(crypto.randomUUID());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setDone(false);
    const invalid = convertAmountError(amount);
    setError(invalid);
    if (!invalid) setConfirming(true);
  }

  function convert() {
    startTransition(async () => {
      try {
        const result = await convertCommissionAction({ amount, requestId: requestId.current });
        if (result.error) {
          setError(result.error);
          return;
        }
        requestId.current = crypto.randomUUID();
        setDone(true);
        router.refresh();
      } catch {
        setError("Falha ao converter a comissão em créditos.");
      } finally {
        setConfirming(false);
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="convert-amount" label="Valor a converter (R$)" helper="O valor sai da sua comissão e entra no saldo de créditos." error={error}>
        {(a11y) => (
          <Input
            {...a11y}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={pending}
          />
        )}
      </Field>
      {done && <StatusBanner tone="success" title="Valor convertido em créditos." />}
      <Button type="submit" glow className="w-full sm:w-auto">
        Usar como crédito
      </Button>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Converter em créditos" role="alertdialog" dismissible={!pending}>
        <p className="text-base text-muted-foreground">
          {formatCurrency(Number(amount))} saem da sua comissão e entram no saldo de créditos. A conversão não pode ser desfeita: esse valor não
          poderá mais ser sacado por PIX.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
            Voltar
          </Button>
          {/* Segundo clique de um duplo clique em "Usar como crédito" não confirma (teclado tem detail 0 e passa). */}
          <Button type="button" onClick={(e) => e.detail <= 1 && convert()} disabled={pending}>
            {pending ? "Convertendo..." : "Converter"}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
