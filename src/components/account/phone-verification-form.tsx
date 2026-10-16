"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { confirmPhoneAction, requestPhoneVerificationAction } from "@/actions/account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { phoneCodeSchema, phoneRequestSchema } from "@/lib/validators/account";

type PhoneValues = z.infer<typeof phoneRequestSchema>;
type CodeValues = z.infer<typeof phoneCodeSchema>;

export interface PhoneVerificationFormProps {
  phoneE164: string | null;
  phoneVerified: boolean;
}

export function PhoneVerificationForm({ phoneE164, phoneVerified }: PhoneVerificationFormProps) {
  const router = useRouter();
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneForm = useForm<PhoneValues>({
    resolver: zodResolver(phoneRequestSchema),
    defaultValues: { phone: "" },
  });
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(phoneCodeSchema),
    defaultValues: { code: "" },
  });

  const sendCode = async (values: PhoneValues) => {
    setError(null);
    const result = await requestPhoneVerificationAction(values);
    if (result.error) return setError(result.error);
    setCodeSent(true);
  };

  const confirm = async (values: CodeValues) => {
    setError(null);
    const result = await confirmPhoneAction(values);
    if (result.error) return setError(result.error);
    setCodeSent(false);
    router.refresh();
  };

  const { errors: phoneErrors, isSubmitting: sending } = phoneForm.formState;
  const { errors: codeErrors, isSubmitting: confirming } = codeForm.formState;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span>{phoneE164 ?? "Nenhum telefone cadastrado"}</span>
        {phoneE164 && (
          <Badge variant={phoneVerified ? "default" : "secondary"}>
            {phoneVerified ? "Confirmado" : "Não confirmado"}
          </Badge>
        )}
      </div>

      <form onSubmit={phoneForm.handleSubmit(sendCode)} className="space-y-2" noValidate>
        <Label htmlFor="phone">Celular com DDD</Label>
        <div className="flex gap-2">
          <Input id="phone" type="tel" autoComplete="tel" {...phoneForm.register("phone")} />
          <Button type="submit" disabled={sending}>
            {sending ? "Enviando..." : "Enviar código"}
          </Button>
        </div>
        {phoneErrors.phone && <p className="text-sm text-destructive">{phoneErrors.phone.message}</p>}
      </form>

      {codeSent && (
        <form onSubmit={codeForm.handleSubmit(confirm)} className="space-y-2" noValidate>
          <p className="text-sm text-muted-foreground">Enviamos um código pelo WhatsApp. Ele vale 10 minutos.</p>
          <Label htmlFor="code">Código</Label>
          <div className="flex gap-2">
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              {...codeForm.register("code")}
            />
            <Button type="submit" disabled={confirming}>
              {confirming ? "Confirmando..." : "Confirmar"}
            </Button>
          </div>
          {codeErrors.code && <p className="text-sm text-destructive">{codeErrors.code.message}</p>}
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
