"use client";

import { useState, useTransition } from "react";

import { resendEmailVerificationAction } from "@/actions/account";
import { Button } from "@/components/ui/button";

export function EmailVerificationBanner() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const resend = () =>
    startTransition(async () => {
      const result = await resendEmailVerificationAction();
      setMessage(
        result.error ? { text: result.error, isError: true } : { text: "E-mail reenviado.", isError: false },
      );
    });

  return (
    <div role="status" className="border-b bg-amber-50 text-amber-950">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
        <span>Confirme seu e-mail para comprar créditos. Enviamos um link para o seu e-mail.</span>
        <span className="flex items-center gap-3">
          {message && <span className={message.isError ? "text-destructive" : undefined}>{message.text}</span>}
          <Button type="button" size="sm" variant="outline" onClick={resend} disabled={pending}>
            {pending ? "Enviando..." : "Reenviar e-mail"}
          </Button>
        </span>
      </div>
    </div>
  );
}
