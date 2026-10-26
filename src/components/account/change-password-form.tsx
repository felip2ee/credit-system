"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { authClient } from "@/lib/auth/client";
import { newPasswordSchema } from "@/lib/validators/password";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/auth/password-input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

const schema = newPasswordSchema.and(
  z.object({ currentPassword: z.string().min(1, "Informe a senha atual.") }),
);

type FormValues = z.infer<typeof schema>;

function errorMessage(status: number | undefined, code: string | undefined): string {
  if (status === 429) return "Muitas tentativas. Aguarde alguns segundos.";
  if (code === "INVALID_PASSWORD") return "Senha atual incorreta.";
  if (code === "PASSWORD_UNCHANGED") return "A nova senha deve ser diferente da senha atual.";
  return "Não foi possível trocar a senha.";
}

export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", password: "", confirm: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setError(null);
    setDone(false);
    const result = await authClient.changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.password,
    });
    if (result.error) return setError(errorMessage(result.error.status, result.error.code));
    reset();
    setDone(true);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field id="currentPassword" label="Senha atual" error={errors.currentPassword?.message}>
        {(a) => <PasswordInput autoComplete="current-password" {...a} {...register("currentPassword")} />}
      </Field>
      <Field id="password" label="Nova senha" error={errors.password?.message}>
        {(a) => <PasswordInput {...a} {...register("password")} />}
      </Field>
      <Field id="confirm" label="Confirmar nova senha" error={errors.confirm?.message}>
        {(a) => <PasswordInput {...a} {...register("confirm")} />}
      </Field>
      {error && <StatusBanner tone="attention" title={error} />}
      {done && <StatusBanner tone="success" title="Senha alterada." description="Os outros dispositivos foram desconectados." />}
      <Button type="submit" className="w-full sm:w-auto" disabled={isSubmitting}>
        {isSubmitting ? "Salvando..." : "Alterar senha"}
      </Button>
    </form>
  );
}
