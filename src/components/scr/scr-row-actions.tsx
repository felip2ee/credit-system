"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { sendScrSelfAuthorization } from "@/actions/scr-self";
import { Button } from "@/components/ui/button";

interface ScrRowActionsProps {
  id: string;
}

export function ScrRowActions({ id }: ScrRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  // Autogestão Rainha Cred: envia o nosso próprio termo + código por
  // e-mail. A gestão pela deps foi descontinuada (consultas usam autorizacaoScr).
  const selfSend = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await sendScrSelfAuthorization(id);
      setMsg(res.error ?? "Autorização na fila de envio");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      <Button variant="default" size="sm" onClick={selfSend} disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar autorização"}
      </Button>
    </div>
  );
}
