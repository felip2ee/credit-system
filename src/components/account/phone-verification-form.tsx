"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { confirmPhoneAction, requestPhoneVerificationAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
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
      <div className="flex items-center gap-2 text-base">
        <span>{phoneE164 ?? "Nenhum telefone cadastrado"}</span>
        {phoneE164 && (
          <StatusBadge tone={phoneVerified ? "success" : "waiting"} label={phoneVerified ? "Confirmado" : "Não confirmado"} />
        )}
      </div>

      <form onSubmit={phoneForm.handleSubmit(sendCode)} className="space-y-2" noValidate>
        <Field id="phone" label="Celular com DDD" error={phoneErrors.phone?.message}>
          {(a11y) => (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input {...a11y} type="tel" autoComplete="tel" {...phoneForm.register("phone")} />
              <Button type="submit" className="w-full sm:w-auto" disabled={sending}>
                {sending ? "Enviando..." : "Enviar código"}
              </Button>
            </div>
          )}
        </Field>
      </form>

      {codeSent && (
        <form onSubmit={codeForm.handleSubmit(confirm)} className="space-y-2" noValidate>
          <p className="text-base text-muted-foreground">Enviamos um código pelo WhatsApp. Ele vale 10 minutos.</p>
          <Field id="code" label="Código" error={codeErrors.code?.message}>
            {(a11y) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  {...a11y}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  {...codeForm.register("code")}
                />
                <Button type="submit" className="w-full sm:w-auto" disabled={confirming}>
                  {confirming ? "Confirmando..." : "Confirmar"}
                </Button>
              </div>
            )}
          </Field>
        </form>
      )}

      {error && <StatusBanner tone="attention" title={error} />}
    </div>
  );
}
