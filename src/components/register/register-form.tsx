"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { registerClientAction } from "@/actions/register";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";
import { registerFormSchema, type RegisterFormValues } from "@/lib/validators/register";

export interface RegisterFormProps {
  slug: string;
  bureauName: string;
  termsVersion: number;
  privacyVersion: number;
}

const linkClass = "underline underline-offset-4 hover:text-foreground";

export function RegisterForm({ slug, bureauName, termsVersion, privacyVersion }: RegisterFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: {
      slug,
      type: "PF",
      name: "",
      document: "",
      email: "",
      phone: "",
      password: "",
      confirm: "",
      acceptedTerms: false,
      termsVersion,
      privacyVersion,
    },
  });
  const isPJ = watch("type") === "PJ";

  const onSubmit = async (values: RegisterFormValues) => {
    setServerError(null);
    const result = await registerClientAction(values);
    if (result.error) {
      setServerError(result.error);
      return;
    }
    const login = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      callbackURL: "/portal",
    });
    if (login.error) router.push("/login");
  };

  const fieldError = (name: keyof RegisterFormValues) => {
    const message = errors[name]?.message;
    return message ? (
      <p id={`${name}-error`} className="text-sm text-destructive">
        {message}
      </p>
    ) : null;
  };
  const describedBy = (name: keyof RegisterFormValues) => (errors[name] ? `${name}-error` : undefined);

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Criar conta</CardTitle>
        <CardDescription>{bureauName}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="type">Tipo de pessoa</Label>
            <select
              id="type"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              {...register("type")}
            >
              <option value="PF">Pessoa física</option>
              <option value="PJ">Pessoa jurídica</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">{isPJ ? "Razão social" : "Nome completo"}</Label>
            <Input id="name" autoComplete={isPJ ? "organization" : "name"} aria-describedby={describedBy("name")} {...register("name")} />
            {fieldError("name")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="document">{isPJ ? "CNPJ" : "CPF"}</Label>
            <Input id="document" inputMode="numeric" aria-describedby={describedBy("document")} {...register("document")} />
            {fieldError("document")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" autoComplete="email" aria-describedby={describedBy("email")} {...register("email")} />
            {fieldError("email")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Celular (com DDD)</Label>
            <Input id="phone" type="tel" autoComplete="tel" aria-describedby={describedBy("phone")} {...register("phone")} />
            {fieldError("phone")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Senha</Label>
            <PasswordInput id="password" aria-describedby={describedBy("password")} {...register("password")} />
            {fieldError("password")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirmar senha</Label>
            <PasswordInput id="confirm" aria-describedby={describedBy("confirm")} {...register("confirm")} />
            {fieldError("confirm")}
          </div>
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <input
                id="acceptedTerms"
                type="checkbox"
                className="mt-1 h-4 w-4"
                aria-describedby={describedBy("acceptedTerms")}
                {...register("acceptedTerms")}
              />
              <Label htmlFor="acceptedTerms" className="font-normal leading-snug">
                Li e aceito os{" "}
                <Link href="/termos" target="_blank" rel="noopener noreferrer" className={linkClass}>
                  Termos de Uso
                </Link>{" "}
                e a{" "}
                <Link href="/privacidade" target="_blank" rel="noopener noreferrer" className={linkClass}>
                  Política de Privacidade
                </Link>
              </Label>
            </div>
            {fieldError("acceptedTerms")}
          </div>
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Criando conta..." : "Criar conta"}
          </Button>
          <div className="text-center">
            <Link href="/login" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              Já tenho conta
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
