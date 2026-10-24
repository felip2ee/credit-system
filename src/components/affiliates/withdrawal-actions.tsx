"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelWithdrawalAction, markWithdrawalPaidAction } from "@/actions/affiliate-withdrawals";
import { canActOnWithdrawal } from "@/components/affiliates/withdrawal-queue-rules";
import { RECEIPT_ACCEPT, validateReceiptFile } from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WithdrawalStatus } from "@/lib/affiliates/withdrawals";

const MAX_REASON_LENGTH = 500;

interface WithdrawalActionsProps {
  withdrawalId: string;
  status: WithdrawalStatus;
  // Valor líquido já formatado: aparece na confirmação, porque pagar é irreversível.
  net: string;
}

export function WithdrawalActions({ withdrawalId, status, net }: WithdrawalActionsProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmingPay, setConfirmingPay] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!canActOnWithdrawal(status)) return null;

  const reviewPay = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateReceiptFile(file);
    if (problem || !file) return setPayError(problem);
    setPayError(null);
    setConfirmingPay(true);
  };

  const confirmPay = () => {
    if (!file) return;
    const formData = new FormData();
    formData.set("withdrawalId", withdrawalId);
    formData.set("receipt", file);
    startTransition(async () => {
      const res = await markWithdrawalPaidAction(formData);
      setConfirmingPay(false);
      if (res.error) {
        if (inputRef.current) inputRef.current.value = "";
        setFile(null);
        return setPayError(res.error);
      }
      router.refresh();
    });
  };

  const reviewCancel = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return setCancelError("Informe o motivo do cancelamento.");
    if (trimmed.length > MAX_REASON_LENGTH) return setCancelError("O motivo deve ter até 500 caracteres.");
    setCancelError(null);
    setConfirmingCancel(true);
  };

  const confirmCancel = () => {
    startTransition(async () => {
      const res = await cancelWithdrawalAction({ id: withdrawalId, reason: reason.trim() });
      setConfirmingCancel(false);
      if (res.error) return setCancelError(res.error);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Marcar como pago</CardTitle>
          <CardDescription>Anexe o comprovante do PIX (PDF, PNG ou JPEG, até 5 MB).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={reviewPay} className="space-y-3" noValidate>
            <Input
              ref={inputRef}
              type="file"
              accept={RECEIPT_ACCEPT}
              aria-label="Comprovante do pagamento (PDF, PNG ou JPEG, até 5 MB)"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={isPending}
              className="h-auto"
            />
            {payError && (
              <p role="alert" className="text-sm text-destructive">
                {payError}
              </p>
            )}
            <Button type="submit" disabled={isPending}>
              Marcar como pago
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Cancelar saque</CardTitle>
          <CardDescription>O valor volta ao saldo da afiliada. O motivo aparece para ela.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={reviewCancel} className="space-y-3" noValidate>
            <Label htmlFor="cancel-reason">Motivo do cancelamento</Label>
            <textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MAX_REASON_LENGTH}
              rows={3}
              disabled={isPending}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {cancelError && (
              <p role="alert" className="text-sm text-destructive">
                {cancelError}
              </p>
            )}
            <Button type="submit" variant="outline" disabled={isPending}>
              Cancelar saque
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={confirmingPay}
        onClose={() => setConfirmingPay(false)}
        title="Marcar saque como pago?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Valor líquido</dt>
            <dd className="font-semibold">{net}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Comprovante</dt>
            <dd className="break-all">{file?.name}</dd>
          </div>
        </dl>
        <p className="text-sm">Esta ação não pode ser desfeita.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" autoFocus onClick={() => setConfirmingPay(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" size="sm" onClick={confirmPay} disabled={isPending}>
            {isPending ? "Enviando..." : "Confirmar pagamento"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        title="Cancelar saque?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <p className="text-sm">O valor volta ao saldo da afiliada.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" autoFocus onClick={() => setConfirmingCancel(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" size="sm" onClick={confirmCancel} disabled={isPending}>
            {isPending ? "Cancelando..." : "Confirmar cancelamento"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
