"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { signOut } from "@/actions/auth";
import { authClient } from "@/lib/auth/client";
import { newPasswordSchema } from "@/lib/validators/password";
import { Button } from "@/components/ui/button";
import { AuthHeading } from "@/components/auth/auth-heading";
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
  return "Não foi possível trocar a senha.";
}

export default function ChangePasswordPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", password: "", confirm: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setError(null);
    if (values.password === values.currentPassword) {
      setError("A nova senha deve ser diferente da senha atual.");
      return;
    }
    const result = await authClient.changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.password,
    });
    if (result.error) {
      setError(errorMessage(result.error.status, result.error.code));
      return;
    }
    router.replace("/");
    router.refresh();
  };

  return (
    <section className="w-full max-w-md space-y-8">
      <AuthHeading
        title="Defina uma nova senha"
        description="Sua senha foi definida por um administrador. Crie uma senha pessoal para continuar."
      />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <Field id="currentPassword" label="Senha atual" error={errors.currentPassword?.message}>
          {(a) => <PasswordInput withIcon autoComplete="current-password" {...a} {...register("currentPassword")} />}
        </Field>
        <Field id="password" label="Nova senha" error={errors.password?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("password")} />}
        </Field>
        <Field id="confirm" label="Confirmar nova senha" error={errors.confirm?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("confirm")} />}
        </Field>
        {error && <StatusBanner tone="attention" title={error} />}
        <Button type="submit" size="lg" glow className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Salvando..." : "Salvar nova senha"}
        </Button>
      </form>
      <form action={signOut}>
        <Button type="submit" variant="outline" size="lg" className="w-full">
          Sair
        </Button>
      </form>
    </section>
  );
}
