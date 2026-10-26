"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { authClient } from "@/lib/auth/client";
import { newPasswordSchema } from "@/lib/validators/password";
import { Button } from "@/components/ui/button";
import { AuthHeading } from "@/components/auth/auth-heading";
import { PasswordInput } from "@/components/auth/password-input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

type FormValues = z.infer<typeof newPasswordSchema>;

function UpdatePasswordForm() {
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setError(null);
    if (!token) {
      setError("Não foi possível atualizar a senha. O link pode ter expirado.");
      return;
    }
    const result = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });
    if (result.error) {
      setError("Não foi possível atualizar a senha. O link pode ter expirado.");
      return;
    }
    window.location.href = "/login";
  };

  return (
    <section className="w-full max-w-md space-y-8">
      <AuthHeading title="Definir nova senha" description="Escolha uma senha forte" />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <Field id="password" label="Nova senha" error={errors.password?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("password")} />}
        </Field>
        <Field id="confirm" label="Confirmar senha" error={errors.confirm?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("confirm")} />}
        </Field>
        {error && <StatusBanner tone="attention" title={error} />}
        <Button type="submit" size="lg" glow className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Salvando..." : "Salvar nova senha"}
        </Button>
      </form>
    </section>
  );
}

export default function UpdatePasswordPage() {
  return (
    <Suspense fallback={null}>
      <UpdatePasswordForm />
    </Suspense>
  );
}
