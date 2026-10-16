"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createPayoutAction } from "@/actions/payouts";
import { cutoffFromDate } from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency, todayInSaoPaulo } from "@/lib/utils";

interface CreatePayoutFormProps {
  bureaus: { id: string; name: string; payable: string }[];
}

export function CreatePayoutForm({ bureaus }: CreatePayoutFormProps) {
  const router = useRouter();
  const [bureauId, setBureauId] = useState(bureaus[0]?.id ?? "");
  const [cutoff, setCutoff] = useState(todayInSaoPaulo);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const selected = bureaus.find((b) => b.id === bureauId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const cutoffAt = cutoffFromDate(cutoff);
    if (!bureauId) return setError("Escolha o Bureau.");
    if (!cutoffAt) return setError("Informe a data de corte.");
    setError(null);
    setDone(false);
    startTransition(async () => {
      const res = await createPayoutAction({ bureauId, cutoffAt });
      if (res.error) return setError(res.error);
      setDone(true);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Novo repasse</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="payout-bureau">Bureau</Label>
            <select
              id="payout-bureau"
              value={bureauId}
              onChange={(e) => {
                setBureauId(e.target.value);
                setDone(false);
              }}
              disabled={isPending}
              className="flex h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bureaus.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-cutoff">Data de corte</Label>
            <Input
              id="payout-cutoff"
              type="date"
              value={cutoff}
              onChange={(e) => {
                setCutoff(e.target.value);
                setDone(false);
              }}
              disabled={isPending}
              className="w-44"
            />
          </div>
          {selected && (
            <p className="text-sm text-muted-foreground">
              Valor a receber do Bureau hoje: <strong>{formatCurrency(Number(selected.payable))}</strong>. É o saldo
              atual, sem filtro pela data de corte; o valor exato do repasse é calculado ao criar.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {done && (
            <p role="status" className="text-sm text-muted-foreground">
              Repasse criado.
            </p>
          )}
          <Button type="submit" disabled={isPending || bureaus.length === 0}>
            {isPending ? "Criando..." : "Criar repasse"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
