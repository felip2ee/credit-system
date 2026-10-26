"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { sendTestNotificationAction } from "@/actions/notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TestNotificationForm() {
  const router = useRouter();
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setDone(false);
    startTransition(async () => {
      const res = await sendTestNotificationAction({ channel, recipient });
      if (res.error) setError(res.error);
      else {
        setDone(true);
        setRecipient("");
      }
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Enviar teste">
      <div className="space-y-1">
        <Label htmlFor="test-channel">Canal</Label>
        <select
          id="test-channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as "email" | "whatsapp")}
          className="flex h-11 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="email">E-mail</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>
      <div className="min-w-64 flex-1 space-y-1">
        <Label htmlFor="test-recipient">Destinatário</Label>
        <Input
          id="test-recipient"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder={channel === "email" ? "nome@exemplo.com" : "+5511999999999"}
          autoComplete="off"
          required
        />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar teste"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="w-full text-sm text-muted-foreground">
          Teste na fila de envio.
        </p>
      )}
    </form>
  );
}
