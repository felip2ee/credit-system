"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { markPayoutPaidAction } from "@/actions/payouts";
import {
  RECEIPT_ACCEPT,
  validateReceiptFile,
} from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface MarkPaidFormProps {
  payoutId: string;
  // Bureau, corte e valor do repasse: mostrados na confirmação (a ação é irreversível).
  bureauName: string;
  cutoff: string;
  amount: string;
}

export function MarkPaidForm({
  payoutId,
  bureauName,
  cutoff,
  amount,
}: MarkPaidFormProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const summary = `${bureauName}, corte ${cutoff}`;

  // O servidor decide; esta checagem só poupa o envio.
  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateReceiptFile(file);
    if (problem || !file) return setError(problem);
    setError(null);
    setConfirming(true);
  };

  const confirm = () => {
    if (!file) return;
    const formData = new FormData();
    formData.set("payoutId", payoutId);
    formData.set("receipt", file);
    startTransition(async () => {
      const res = await markPayoutPaidAction(formData);
      setConfirming(false);
      if (res.error) {
        // Limpa o arquivo para o operador escolher o comprovante certo de novo.
        if (inputRef.current) inputRef.current.value = "";
        setFile(null);
        return setError(res.error);
      }
      router.refresh();
    });
  };

  return (
    <form onSubmit={review} className="space-y-2" noValidate>
      <Input
        ref={inputRef}
        type="file"
        accept={RECEIPT_ACCEPT}
        aria-label={`Comprovante do repasse ${summary} (PDF, PNG ou JPEG, até 5 MB)`}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={isPending}
        className="h-auto max-w-xs"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={isPending}
        aria-label={`Marcar como pago o repasse ${summary}`}
      >
        Marcar como pago
      </Button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Marcar repasse como pago?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Bureau</dt>
            <dd>{bureauName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Corte</dt>
            <dd>{cutoff}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Valor</dt>
            <dd className="font-semibold">{amount}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Comprovante</dt>
            <dd className="break-all">{file?.name}</dd>
          </div>
        </dl>
        <p className="text-sm">Esta ação não pode ser desfeita.</p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            autoFocus
            onClick={() => setConfirming(false)}
            disabled={isPending}
          >
            Voltar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={confirm}
            disabled={isPending}
          >
            {isPending ? "Enviando..." : "Confirmar pagamento"}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
