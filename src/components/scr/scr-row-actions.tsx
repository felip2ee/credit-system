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

  // Autogestão Rainha do Crédito: envia o nosso próprio termo + código por
  // e-mail. A gestão pela deps foi descontinuada (consultas usam autorizacaoScr).
  const selfSend = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await sendScrSelfAuthorization(id);
      setMsg(res.error ?? "Autorização enviada por e-mail");
      router.refresh();
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <Button variant="default" size="sm" onClick={selfSend} disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar autorização"}
      </Button>
    </div>
  );
}
