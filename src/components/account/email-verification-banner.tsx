"use client";

import { useState, useTransition } from "react";

import { resendEmailVerificationAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

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
    <div className="mx-auto w-full max-w-3xl px-screen pt-4 md:max-w-5xl">
      <StatusBanner
        tone="waiting"
        title="Confirme seu e-mail para comprar créditos."
        description={
          <>
            <p>Enviamos um link para o seu e-mail.</p>
            {message && <p className="font-bold">{message.text}</p>}
          </>
        }
        action={
          <Button type="button" variant="outline" onClick={resend} disabled={pending}>
            {pending ? "Enviando..." : "Reenviar e-mail"}
          </Button>
        }
      />
    </div>
  );
}
