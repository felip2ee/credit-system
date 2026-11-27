"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setNotificationChannelAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";

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
      <Field
        id="channel"
        label="Canal de avisos"
        helper={phoneVerified ? undefined : "Confirme o telefone para usar o WhatsApp."}
        error={message?.isError ? message.text : null}
      >
        {(a11y) => (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={value} onValueChange={(v) => setValue(v === "whatsapp" ? "whatsapp" : "email")}>
              <SelectTrigger {...a11y}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="whatsapp" disabled={!phoneVerified}>
                  WhatsApp
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" className="w-full sm:w-auto" onClick={save} disabled={pending}>
              {pending ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        )}
      </Field>
      {message && !message.isError && <StatusBanner tone="success" title={message.text} />}
    </div>
  );
}
