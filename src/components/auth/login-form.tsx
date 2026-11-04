"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { AuthHeading } from "@/components/auth/auth-heading";
import { IconInput } from "@/components/auth/icon-input";
import { PasswordInput } from "@/components/auth/password-input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

const loginSchema = z.object({
  email: z.string().email("Informe um e-mail válido."),
  password: z.string().min(12, "A senha deve ter ao menos 12 caracteres."),
});
type LoginValues = z.infer<typeof loginSchema>;

function callbackPath(value: string | null): string {
  return value?.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
    ? value
    : "/";
}

// Usa useSearchParams: quem renderiza precisa envolver em <Suspense>.
// withHeading = false quando a página já tem o próprio título (ex.: entrada do Bureau).
export function LoginForm({ withHeading = true }: { withHeading?: boolean }) {
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });
  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    const result = await authClient.signIn.email({
      ...values,
      callbackURL: callbackPath(searchParams.get("next")),
    });
    if (result.error) setServerError("E-mail ou senha inválidos.");
  };
  return (
    <section className="w-full max-w-md space-y-8">
      {withHeading && <AuthHeading title="Entrar" description="Use o e-mail e a senha da sua conta" />}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <Field id="email" label="E-mail" error={errors.email?.message}>
          {(a) => <IconInput icon={Mail} type="email" autoComplete="email" {...a} {...register("email")} />}
        </Field>
        <Field id="password" label="Senha" error={errors.password?.message}>
          {(a) => (
            <PasswordInput
              withIcon
              toggleLabels={["Mostrar texto digitado", "Ocultar texto digitado"]}
              autoComplete="current-password"
              {...a}
              {...register("password")}
            />
          )}
        </Field>
        {serverError && (
          <StatusBanner tone="attention" title={serverError} description="Confira os dados e tente de novo." />
        )}
        <Button type="submit" variant="cta" size="lg" glow className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Entrando..." : "Entrar"}
        </Button>
        <div className="text-center">
          <Link
            href="/reset-password"
            className="inline-flex min-h-12 items-center text-base font-bold text-primary underline-offset-4 hover:underline"
          >
            Esqueci minha senha
          </Link>
        </div>
      </form>
    </section>
  );
}
