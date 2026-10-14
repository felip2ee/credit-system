"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { startSupportSession } from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SupportStartForm({ bureauId }: { bureauId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await startSupportSession({ bureauId, reason });
      if (result.error) setError(result.error);
      else router.push("/");
    });
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4 border-t pt-6">
      <h2 className="text-lg font-semibold">Entrar em modo suporte</h2>
      <p className="text-sm text-muted-foreground">
        A sessão dura até 1 hora e cada ação fica registrada na auditoria do Bureau.
      </p>
      <div className="space-y-2">
        <Label htmlFor="support-reason">Motivo</Label>
        <Input
          id="support-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Entrando..." : "Entrar em modo suporte"}
      </Button>
    </form>
  );
}
