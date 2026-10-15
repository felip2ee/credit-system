"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

export function RevokeSessionsButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const revoke = async () => {
    setPending(true);
    setMessage(null);
    try {
      const result = await authClient.revokeOtherSessions();
      setMessage(
        result.error
          ? { text: "Não foi possível desconectar os outros dispositivos.", isError: true }
          : { text: "Outros dispositivos desconectados.", isError: false },
      );
    } catch {
      setMessage({ text: "Não foi possível desconectar os outros dispositivos.", isError: true });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={revoke} disabled={pending}>
        {pending ? "Desconectando..." : "Sair dos outros dispositivos"}
      </Button>
      {message && (
        <p role="status" className={message.isError ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
