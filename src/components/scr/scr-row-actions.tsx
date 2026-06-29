"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { resendScr, verifyScr } from "@/actions/scr";
import { Button } from "@/components/ui/button";
import type { EntityKind } from "@/types/app";

interface ScrRowActionsProps {
  id: string;
  document: string;
  type: EntityKind;
  name: string | null;
  email: string | null;
}

export function ScrRowActions({
  id,
  document,
  type,
  name,
  email,
}: ScrRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const verify = () => {
    setMsg(null);
    startTransition(async () => {
      const result = await verifyScr(id, document);
      setMsg(result.message);
      // Autorizado: a consulta foi concluída — leva direto ao resultado.
      if (result.status === "authorized" && result.queryId) {
        router.push(`/consultations/${result.queryId}`);
      }
      router.refresh();
    });
  };

  const resend = () => {
    setMsg(null);
    startTransition(async () => {
      await resendScr(id, document, type, name, email);
      setMsg("E-mail reenviado");
      router.refresh();
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <Button variant="outline" size="sm" onClick={verify} disabled={isPending}>
        Verificar agora
      </Button>
      <Button variant="ghost" size="sm" onClick={resend} disabled={isPending}>
        Reenviar
      </Button>
    </div>
  );
}
