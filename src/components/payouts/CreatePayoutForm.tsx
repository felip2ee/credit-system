"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createPayoutAction } from "@/actions/payouts";
import { cutoffFromDate } from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import { StatusBanner } from "@/components/ui/status-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface CreatePayoutFormProps {
  bureaus: { id: string; name: string; payable: string }[];
  // Última data (AAAA-MM-DD) cujo corte a retenção já liberou. Depois dela o banco recusa o repasse.
  latestDate: string;
}

const brDate = (isoDate: string) => isoDate.split("-").reverse().join("/");

export function CreatePayoutForm({ bureaus, latestDate }: CreatePayoutFormProps) {
  const router = useRouter();
  const [bureauId, setBureauId] = useState(bureaus[0]?.id ?? "");
  const [cutoff, setCutoff] = useState(latestDate);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const selected = bureaus.find((b) => b.id === bureauId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const cutoffAt = cutoffFromDate(cutoff);
    if (!bureauId) return setError("Escolha o Bureau.");
    if (!cutoffAt) return setError("Informe a data de corte.");
    if (cutoff > latestDate) return setError(`Esse valor ainda está em liberação. Escolha uma data até ${brDate(latestDate)}.`);
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
            <Select
              value={bureauId}
              onValueChange={(value) => {
                setBureauId(value);
                setDone(false);
              }}
              disabled={isPending}
            >
              <SelectTrigger id="payout-bureau" className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bureaus.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              max={latestDate}
              disabled={isPending}
              className="w-44"
            />
            <p className="text-xs text-muted-foreground">
              O valor só pode ser repassado depois da retenção. Escolha uma data até {brDate(latestDate)}.
            </p>
          </div>
          {selected && (
            <p className="text-sm text-muted-foreground">
              Valor a receber do Bureau hoje: <strong>{formatCurrency(Number(selected.payable))}</strong>. É o saldo
              atual, sem filtro pela data de corte; o valor exato do repasse é calculado ao criar.
            </p>
          )}
          {error && (
            <StatusBanner tone="danger" title={error} />
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
