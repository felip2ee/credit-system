"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { authClient } from "@/lib/auth/client";
import { newPasswordSchema } from "@/lib/validators/password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
      <div className="space-y-2">
        <Label htmlFor="currentPassword">Senha atual</Label>
        <Input id="currentPassword" type="password" autoComplete="current-password" {...register("currentPassword")} />
        {errors.currentPassword && <p className="text-sm text-destructive">{errors.currentPassword.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Nova senha</Label>
        <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
        {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirmar nova senha</Label>
        <Input id="confirm" type="password" autoComplete="new-password" {...register("confirm")} />
        {errors.confirm && <p className="text-sm text-destructive">{errors.confirm.message}</p>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-muted-foreground">
          Senha alterada. Os outros dispositivos foram desconectados.
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Salvando..." : "Alterar senha"}
      </Button>
    </form>
  );
}
