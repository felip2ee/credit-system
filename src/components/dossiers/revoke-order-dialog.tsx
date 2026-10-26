"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { revokeOrderAction } from "@/actions/orders";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface RevokeOrderDialogProps {
  dossierId: string;
  open: boolean;
  onClose: () => void;
}

const MAX_REASON = 500;

export function RevokeOrderDialog({ dossierId, open, onClose }: RevokeOrderDialogProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (reason.trim() === "") {
      setError("Informe o motivo.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await revokeOrderAction({ dossierId, reason });
      if (res.error) {
        setError(res.error);
        return;
      }
      setReason("");
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Revogar entrega" role="alertdialog" dismissible={!isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted-foreground">
          O cliente perde o acesso à pesquisa. O pedido volta para &quot;Pronto, aguardando liberação do Bureau&quot; e o cliente não é avisado.
        </p>
        <div className="space-y-2">
          <Label htmlFor="revoke-reason">Motivo da revogação</Label>
          <Input
            id="revoke-reason"
            autoFocus
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isPending}
            aria-invalid={error !== null}
            aria-describedby={error ? "revoke-error" : undefined}
          />
        </div>
        {error && (
          <p id="revoke-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Voltar
          </Button>
          <Button type="submit" variant="destructive" disabled={isPending}>
            {isPending ? "Revogando..." : "Revogar"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
