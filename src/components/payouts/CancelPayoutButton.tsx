"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cancelPayoutAction } from "@/actions/payouts";
import { Button } from "@/components/ui/button";

export function CancelPayoutButton({ payoutId }: { payoutId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
    <div className="space-y-2">
      {confirming ? (
        <div role="alertdialog" aria-label="Confirmar cancelamento" className="space-y-2">
          <p className="text-sm">Cancelar este repasse? Os lançamentos voltam a ficar disponíveis para um novo repasse.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={cancel} disabled={isPending}>
              {isPending ? "Cancelando..." : "Confirmar cancelamento"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
              Voltar
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Cancelar repasse
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
