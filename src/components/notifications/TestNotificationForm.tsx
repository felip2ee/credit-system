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
      <div className="w-full space-y-1 sm:w-auto">
        <Label htmlFor="test-channel">Canal</Label>
        <select
          id="test-channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as "email" | "whatsapp")}
          className="flex h-11 w-full rounded-input border border-input bg-background px-3 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm admin:h-10 admin:text-sm"
        >
          <option value="email">E-mail</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>
      <div className="w-full flex-1 space-y-1 sm:min-w-64">
        <Label htmlFor="test-recipient">Destinatário</Label>
        <Input
          id="test-recipient"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder={channel === "email" ? "nome@exemplo.com" : "+5511999999999"}
          autoComplete="off"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "test-error" : undefined}
        />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar teste"}
      </Button>
      {error && (
        <p id="test-error" role="alert" className="w-full text-sm text-destructive">
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
