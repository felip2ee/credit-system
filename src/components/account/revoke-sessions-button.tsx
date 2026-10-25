"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

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
      <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={revoke} disabled={pending}>
        {pending ? "Desconectando..." : "Sair dos outros dispositivos"}
      </Button>
      {message && <StatusBanner tone={message.isError ? "attention" : "success"} title={message.text} />}
    </div>
  );
}
