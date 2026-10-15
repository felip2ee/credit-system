"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelPayoutAction } from "@/actions/payouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface CancelPayoutButtonProps {
  payoutId: string;
  // Identifica o repasse (Bureau e corte) no nome acessível e no diálogo.
  summary: string;
}

export function CancelPayoutButton({
  payoutId,
  summary,
}: CancelPayoutButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const close = () => {
    setConfirming(false);
    setError(null);
  };

  const cancel = () => {
    setError(null);
    startTransition(async () => {
      const res = await cancelPayoutAction({ payoutId });
      if (res.error) return setError(res.error);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
        aria-label={`Cancelar repasse ${summary}`}
      >
        Cancelar repasse
      </Button>
      <Dialog
        open={confirming}
        onClose={close}
        title="Cancelar repasse?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <p className="text-sm">
          Repasse: {summary}. Os lançamentos voltam a ficar disponíveis para um
          novo repasse.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            autoFocus
            onClick={close}
            disabled={isPending}
          >
            Voltar
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={cancel}
            disabled={isPending}
          >
            {isPending ? "Cancelando..." : "Confirmar cancelamento"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
