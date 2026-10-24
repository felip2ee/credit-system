"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { convertCommissionAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
      <div className="space-y-1">
        <Label htmlFor="convert-amount">Valor a converter (R$)</Label>
        <Input
          id="convert-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={pending}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-green-700">Valor convertido em créditos.</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Convertendo..." : "Usar como crédito"}
      </Button>
    </form>
  );
}
