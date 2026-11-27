"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { startSupportSession } from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";

// Mesma mensagem do servidor (src/actions/support.ts, startSchema).
const REASON_REQUIRED = "Informe o motivo do suporte.";

export function SupportStartForm({ bureauId }: { bureauId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (reason.trim() === "") {
      setReasonError(REASON_REQUIRED);
      document.getElementById("support-reason")?.focus();
      return;
    }
    setReasonError(null);
    startTransition(async () => {
      const result = await startSupportSession({ bureauId, reason });
      if (result.error) setError(result.error);
      else router.push("/");
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <h3 className="text-base font-bold">Entrar em modo suporte</h3>
      <p className="text-sm text-muted-foreground">
        A sessão dura até 1 hora e cada ação fica registrada na auditoria do Bureau.
      </p>
      <Field id="support-reason" label="Motivo" helper="Obrigatório. Fica gravado na auditoria." error={reasonError}>
        {(a11y) => (
          <Input
            {...a11y}
            required
            value={reason}
            maxLength={500}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(null);
            }}
          />
        )}
      </Field>
      {error && <StatusBanner tone="danger" title={error} />}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Entrando..." : "Entrar em modo suporte"}
      </Button>
    </form>
  );
}
