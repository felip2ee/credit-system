"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { registerCounterPaymentAction } from "@/actions/counter-payments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { moneyError, normalizeMoney } from "@/lib/catalog/money-input";
import { todayInSaoPaulo } from "@/lib/utils";
import { COUNTER_METHODS } from "@/lib/validators/counter-payments";

export const METHOD_LABEL: Record<(typeof COUNTER_METHODS)[number], string> = {
  cash: "Dinheiro",
  pix: "PIX",
  card_machine: "Maquininha de cartão",
  transfer: "Transferência",
  other: "Outro",
};


interface CounterPaymentFormProps {
  dossierId: string;
}

export function CounterPaymentForm({ dossierId }: CounterPaymentFormProps) {
  const router = useRouter();
  const [method, setMethod] = useState<(typeof COUNTER_METHODS)[number]>("cash");
  const [amount, setAmount] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayInSaoPaulo);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const invalid = moneyError(amount);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await registerCounterPaymentAction({
        dossierId,
        method,
        amount: normalizeMoney(amount),
        receivedAt,
        note: note || null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setAmount("");
      setNote("");
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Registrar pagamento</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cp-method">Forma de pagamento</Label>
            <select
              id="cp-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              disabled={isPending}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {COUNTER_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-amount">Valor (R$)</Label>
            <Input
              id="cp-amount"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isPending}
              aria-invalid={error !== null}
              aria-describedby={error ? "cp-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-date">Data de recebimento</Label>
            <Input
              id="cp-date"
              type="date"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              disabled={isPending}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-note">Observação (opcional)</Label>
            <Input
              id="cp-note"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isPending}
            />
          </div>
          {error && (
            <p id="cp-error" role="alert" className="text-sm text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={isPending || amount === ""}>
              {isPending ? "Registrando..." : "Registrar pagamento"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
