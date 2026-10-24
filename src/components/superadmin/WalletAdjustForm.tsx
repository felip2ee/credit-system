"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { adjustWalletAction } from "@/actions/wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeMoney } from "@/lib/catalog/money-input";
import { signedMoneySchema } from "@/lib/validators/wallet";
import { StatusBanner } from "@/components/ui/status-banner";

export function WalletAdjustForm({ bureauId }: { bureauId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // Uma chave por tentativa: reenvio do mesmo formulário não duplica o ajuste.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeMoney(amount);
    const parsed = signedMoneySchema.safeParse(normalized);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    if (reason.trim() === "") return setError("Informe o motivo do ajuste.");
    setError(null);
    setDone(false);
    startTransition(async () => {
      const res = await adjustWalletAction({ bureauId, amount: normalized, reason, idempotencyKey });
      if (res.error) return setError(res.error);
      setDone(true);
      setAmount("");
      setReason("");
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Ajuste manual</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="adjust-amount">Valor (use - para débito)</Label>
            <Input
              id="adjust-amount"
              inputMode="decimal"
              placeholder="-10,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isPending}
              className="w-40"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-reason">Motivo</Label>
            <Input
              id="adjust-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isPending}
              maxLength={500}
            />
          </div>
          {error && (
            <StatusBanner tone="danger" title={error} />
          )}
          {done && (
            <p role="status" className="text-sm text-muted-foreground">
              Ajuste registrado.
            </p>
          )}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Ajustar saldo"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
