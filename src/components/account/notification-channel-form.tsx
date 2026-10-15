"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setNotificationChannelAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export interface NotificationChannelFormProps {
  channel: "email" | "whatsapp";
  phoneVerified: boolean;
}

export function NotificationChannelForm({ channel, phoneVerified }: NotificationChannelFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<"email" | "whatsapp">(channel);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const save = () =>
    startTransition(async () => {
      const result = await setNotificationChannelAction({ channel: value });
      setMessage(
        result.error ? { text: result.error, isError: true } : { text: "Canal salvo.", isError: false },
      );
      if (!result.error) router.refresh();
    });

  return (
    <div className="space-y-2">
      <Label htmlFor="channel">Canal de avisos</Label>
      <div className="flex gap-2">
        <select
          id="channel"
          value={value}
          onChange={(e) => setValue(e.target.value === "whatsapp" ? "whatsapp" : "email")}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="email">E-mail</option>
          <option value="whatsapp" disabled={!phoneVerified}>
            WhatsApp
          </option>
        </select>
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Salvando..." : "Salvar"}
        </Button>
      </div>
      {!phoneVerified && (
        <p className="text-sm text-muted-foreground">Confirme o telefone para usar o WhatsApp.</p>
      )}
      {message && (
        <p role="status" className={message.isError ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
