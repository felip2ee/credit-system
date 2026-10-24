"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { adjustClientBalanceAction } from "@/actions/client-balance";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import { normalizeMoney } from "@/lib/catalog/money-input";

import { canSubmitAdjustment, REASON_MAX, type AdjustDirection } from "./adjust-balance-rules";

interface AdjustBalanceDialogProps {
  holderId: string;
  bureauAvailable: string;
  clientAvailable: string;
}

export function AdjustBalanceDialog({ holderId, bureauAvailable, clientAvailable }: AdjustBalanceDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [direction, setDirection] = useState<AdjustDirection>("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const check = canSubmitAdjustment({ direction, amount, reason, bureauAvailable, clientAvailable });

  const openDialog = () => {
    setRequestId(crypto.randomUUID());
    setDirection("credit");
    setAmount("");
    setReason("");
    setError(null);
    setOpen(true);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await adjustClientBalanceAction({
        holderId,
        requestId,
        direction,
        amount: normalizeMoney(amount),
        reason: reason.trim(),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  const balanceLabel =
    direction === "credit"
      ? `Saldo da carteira do Bureau: ${formatCurrency(Number(bureauAvailable))}`
      : `Saldo disponível do cliente: ${formatCurrency(Number(clientAvailable))}`;

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        Ajustar saldo
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Ajustar saldo do cliente" dismissible={!isPending}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <fieldset className="space-y-2" disabled={isPending}>
            <legend className="text-sm font-medium">Operação</legend>
            <div className="flex gap-2" role="radiogroup" aria-label="Operação">
              {(["credit", "debit"] as const).map((d) => (
                <Button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={direction === d}
                  variant={direction === d ? "default" : "outline"}
                  size="sm"
                  onClick={() => setDirection(d)}
                >
                  {d === "credit" ? "Adicionar" : "Remover"}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{balanceLabel}</p>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="adjust-amount">Valor (R$)</Label>
            <Input
              id="adjust-amount"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-reason">Motivo</Label>
            <textarea
              id="adjust-reason"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isPending}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="text-right text-xs text-muted-foreground">
              {reason.length}/{REASON_MAX}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending || !check.ok}>
              {isPending ? "Ajustando..." : "Confirmar ajuste"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
