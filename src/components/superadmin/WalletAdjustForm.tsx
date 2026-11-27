"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { adjustWalletAction } from "@/actions/wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";
import { describeAdjustment } from "@/components/superadmin/wallet-adjust-logic";
import { normalizeMoney } from "@/lib/catalog/money-input";
import { signedMoneySchema } from "@/lib/validators/wallet";

interface WalletAdjustFormProps {
  bureauId: string;
  // Nome do Bureau, mostrado na confirmação. Sem ele a confirmação diz "o Bureau aberto nesta página".
  bureauName?: string;
}

export function WalletAdjustForm({ bureauId, bureauName }: WalletAdjustFormProps) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // Uma chave por tentativa: reenvio do mesmo formulário não duplica o ajuste.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const normalized = normalizeMoney(amount);

  // Valida e abre a confirmação; o dinheiro só se move em "Confirmar ajuste".
  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = signedMoneySchema.safeParse(normalized);
    const nextAmountError = parsed.success ? null : parsed.error.issues[0].message;
    const nextReasonError = reason.trim() === "" ? "Informe o motivo do ajuste." : null;
    setAmountError(nextAmountError);
    setReasonError(nextReasonError);
    setServerError(null);
    setDone(false);
    if (nextAmountError || nextReasonError) return;
    setConfirming(true);
  };

  const confirm = () => {
    startTransition(async () => {
      let res;
      try {
        res = await adjustWalletAction({ bureauId, amount: normalized, reason, idempotencyKey });
      } catch {
        // Mesma chave de idempotência: tentar de novo não duplica o ajuste.
        setConfirming(false);
        return setServerError("Não foi possível confirmar o ajuste. Confira o extrato do Bureau antes de tentar de novo.");
      }
      setConfirming(false);
      if (res.error) return setServerError(res.error);
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
        <CardTitle>Ajuste manual</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={review} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            O ajuste muda o saldo da carteira na hora e fica registrado no extrato. Antes de gravar, você confere os dados.
          </p>
          <Field id="adjust-amount" label="Valor (use - para débito)" error={amountError}>
            {(a11y) => (
              <Input
                {...a11y}
                inputMode="decimal"
                placeholder="-10,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isPending}
                className="w-40 max-w-full"
              />
            )}
          </Field>
          <Field id="adjust-reason" label="Motivo" error={reasonError}>
            {(a11y) => (
              <Input {...a11y} value={reason} onChange={(e) => setReason(e.target.value)} disabled={isPending} maxLength={500} />
            )}
          </Field>
          {serverError && <StatusBanner tone="danger" title={serverError} />}
          {done && (
            <p role="status" className="text-sm text-muted-foreground">
              Ajuste registrado.
            </p>
          )}
          <Button type="submit" disabled={isPending}>
            Ajustar saldo
          </Button>
        </form>
      </CardContent>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirmar ajuste de saldo?"
        role="alertdialog"
        dismissible={!isPending}
        className="max-h-[92vh] overflow-y-auto"
      >
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Bureau</dt>
            <dd className="break-words text-right">{bureauName ?? "o Bureau aberto nesta página"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Ajuste</dt>
            <dd className="text-right font-semibold">{describeAdjustment(normalized)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Motivo</dt>
            <dd className="break-words text-right">{reason.trim()}</dd>
          </div>
        </dl>
        <p className="text-sm">O saldo muda na hora e o ajuste fica no extrato.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" size="sm" variant="outline" autoFocus onClick={() => setConfirming(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" size="sm" onClick={confirm} disabled={isPending}>
            {isPending ? "Salvando..." : "Confirmar ajuste"}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
