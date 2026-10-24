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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Defina uma nova senha</CardTitle>
        <CardDescription>
          Sua senha foi definida por um administrador. Crie uma senha pessoal para continuar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Senha atual</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...register("currentPassword")}
            />
            {errors.currentPassword && (
              <p className="text-base text-destructive">{errors.currentPassword.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Nova senha</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-base text-destructive">{errors.password.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirmar nova senha</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              {...register("confirm")}
            />
            {errors.confirm && (
              <p className="text-base text-destructive">{errors.confirm.message}</p>
            )}
          </div>
          {error && <StatusBanner tone="attention" title={error} />}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Salvando..." : "Salvar nova senha"}
          </Button>
        </form>
        <form action={signOut}>
          <Button type="submit" variant="outline" className="w-full">
            Sair
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
