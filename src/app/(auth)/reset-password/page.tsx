"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Mail } from "lucide-react";

import { BackToLogin } from "@/components/auth/auth-exit";
import { AuthHeading } from "@/components/auth/auth-heading";
import { IconInput } from "@/components/auth/icon-input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

const schema = z.object({
  email: z.string().email("Informe um e-mail válido."),
});
type FormValues = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });
  const onSubmit = async ({ email }: FormValues) => {
    setError(null);
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/update-password`,
    });
    if (result.error)
      return setError("Não foi possível enviar o e-mail. Tente novamente.");
    setSent(true);
  };
  return (
    <section className="w-full max-w-md space-y-6">
      <BackToLogin />
      <AuthHeading title="Recuperar senha" description="Enviaremos um link de redefinição por e-mail" />
      <div>
        {sent ? (
          <p className="text-center text-base text-muted-foreground">
            Se houver uma conta com esse e-mail, um link de redefinição foi
            enviado. Verifique sua caixa de entrada.
          </p>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Field id="email" label="E-mail" error={errors.email?.message}>
              {(a) => <IconInput icon={Mail} type="email" autoComplete="email" {...a} {...register("email")} />}
            </Field>
            {error && <StatusBanner tone="attention" title={error} />}
            <Button type="submit" glow className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Enviando..." : "Enviar link"}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
