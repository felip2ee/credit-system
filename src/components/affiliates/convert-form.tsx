"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { convertCommissionAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

interface ConvertFormProps {
  available: string;
}

export function ConvertForm({ available }: ConvertFormProps) {
  const router = useRouter();
  const [amount, setAmount] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  // Mesmo id em cliques repetidos: a conversão acontece uma vez. Novo id só depois do sucesso.
  const requestId = useRef(crypto.randomUUID());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    startTransition(async () => {
      const result = await convertCommissionAction({ amount, requestId: requestId.current });
      if (result.error) {
        setError(result.error);
        return;
      }
      requestId.current = crypto.randomUUID();
      setDone(true);
      router.refresh();
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
      <Button type="submit" glow className="w-full sm:w-auto" disabled={pending}>
        {pending ? "Convertendo..." : "Usar como crédito"}
      </Button>
    </form>
  );
}
