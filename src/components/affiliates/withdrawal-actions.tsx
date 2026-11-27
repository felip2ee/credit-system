"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelWithdrawalAction, markWithdrawalPaidAction } from "@/actions/affiliate-withdrawals";
import { canActOnWithdrawal } from "@/components/affiliates/withdrawal-queue-rules";
import { RECEIPT_ACCEPT, validateReceiptFile } from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { WithdrawalStatus } from "@/lib/affiliates/withdrawals";
import { Textarea } from "@/components/ui/textarea";

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
          <CardTitle>Marcar como pago</CardTitle>
          <CardDescription>Anexe o comprovante do PIX (PDF, PNG ou JPEG, até 5 MB).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={reviewPay} className="space-y-3" noValidate>
            <Field id="withdrawal-receipt" label="Comprovante do pagamento (PDF, PNG ou JPEG, até 5 MB)" error={payError}>
              {(a11y) => (
                <Input
                  {...a11y}
                  ref={inputRef}
                  type="file"
                  accept={RECEIPT_ACCEPT}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  disabled={isPending}
                  className="h-auto"
                />
              )}
            </Field>
            <Button type="submit" disabled={isPending}>
              Marcar como pago
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cancelar saque</CardTitle>
          <CardDescription>O valor volta ao saldo da afiliada. O motivo aparece para ela.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={reviewCancel} className="space-y-3" noValidate>
            <Field id="cancel-reason" label="Motivo do cancelamento" error={cancelError}>
              {(a11y) => (
                <Textarea
                  {...a11y}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={MAX_REASON_LENGTH}
                  rows={3}
                  disabled={isPending}
                />
              )}
            </Field>
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
        className="max-h-[92vh] overflow-y-auto"
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
        <div className="flex flex-wrap justify-end gap-2">
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
        className="max-h-[92vh] overflow-y-auto"
      >
        <p className="text-sm">O valor volta ao saldo da afiliada.</p>
        <div className="flex flex-wrap justify-end gap-2">
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
