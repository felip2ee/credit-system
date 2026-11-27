"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createPayoutAction } from "@/actions/payouts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { brDate, cutoffFromDate } from "@/lib/payouts/cutoff";
import { formatCurrency } from "@/lib/utils";
import { StatusBanner } from "@/components/ui/status-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface CreatePayoutFormProps {
  bureaus: { id: string; name: string; payable: string }[];
  // Última data (AAAA-MM-DD) cujo corte a retenção já liberou. Depois dela o banco recusa o repasse.
  latestDate: string;
}

export function CreatePayoutForm({ bureaus, latestDate }: CreatePayoutFormProps) {
  const router = useRouter();
  const [bureauId, setBureauId] = useState(bureaus[0]?.id ?? "");
  const [cutoff, setCutoff] = useState(latestDate);
  const [bureauError, setBureauError] = useState<string | null>(null);
  const [cutoffError, setCutoffError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const selected = bureaus.find((b) => b.id === bureauId);

  // Valida e abre a confirmação; o repasse só é criado em "Criar repasse".
  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const nextBureauError = bureauId ? null : "Escolha o Bureau.";
    let nextCutoffError: string | null = null;
    if (!cutoffFromDate(cutoff)) nextCutoffError = "Informe a data de corte.";
    else if (cutoff > latestDate) nextCutoffError = `Esse valor ainda está em liberação. Escolha uma data até ${brDate(latestDate)}.`;
    setBureauError(nextBureauError);
    setCutoffError(nextCutoffError);
    setServerError(null);
    setDone(false);
    if (nextBureauError || nextCutoffError) return;
    setConfirming(true);
  };

  const confirm = () => {
    const cutoffAt = cutoffFromDate(cutoff);
    if (!cutoffAt) return;
    startTransition(async () => {
      let res;
      try {
        res = await createPayoutAction({ bureauId, cutoffAt });
      } catch {
        setConfirming(false);
        return setServerError("Não foi possível criar o repasse. Confira a lista de repasses antes de tentar de novo.");
      }
      setConfirming(false);
      if (res.error) return setServerError(res.error);
      setDone(true);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Novo repasse</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={review} className="space-y-4" noValidate>
          <Field id="payout-bureau" label="Bureau" error={bureauError}>
            {(a11y) => (
              <Select
                value={bureauId}
                onValueChange={(value) => {
                  setBureauId(value);
                  setDone(false);
                }}
                disabled={isPending}
              >
                <SelectTrigger {...a11y} className="max-w-sm">
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
            )}
          </Field>
          <Field
            id="payout-cutoff"
            label="Data de corte"
            helper={`O valor só pode ser repassado depois da retenção. Escolha uma data até ${brDate(latestDate)}.`}
            error={cutoffError}
          >
            {(a11y) => (
              <Input
                {...a11y}
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
            )}
          </Field>
          {selected && (
            <p className="text-sm text-muted-foreground">
              Valor a receber do Bureau hoje: <strong>{formatCurrency(Number(selected.payable))}</strong>. É o saldo
              atual, sem filtro pela data de corte; o valor exato do repasse é calculado ao criar.
            </p>
          )}
          {serverError && <StatusBanner tone="danger" title={serverError} />}
          {done && (
            <p role="status" className="text-sm text-muted-foreground">
              Repasse criado.
            </p>
          )}
          <Button type="submit" disabled={isPending || bureaus.length === 0}>
            Criar repasse
          </Button>
        </form>
      </CardContent>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Criar repasse?"
        role="alertdialog"
        dismissible={!isPending}
        className="max-h-[92vh] overflow-y-auto"
      >
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Bureau</dt>
            <dd className="break-words text-right">{selected?.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Data de corte</dt>
            <dd>{brDate(cutoff)}</dd>
          </div>
        </dl>
        <p className="text-sm">
          O valor exato é calculado ao criar. O repasse fica em aberto até você marcar como pago ou cancelar.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" autoFocus onClick={() => setConfirming(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" size="sm" onClick={confirm} disabled={isPending}>
            {isPending ? "Criando..." : "Criar repasse"}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
