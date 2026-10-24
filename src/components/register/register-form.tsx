"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { registerClientAction } from "@/actions/register";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { authClient } from "@/lib/auth/client";
import { registerFormSchema, type RegisterFormValues } from "@/lib/validators/register";

export interface RegisterFormProps {
  slug: string;
  termsVersion: number;
  privacyVersion: number;
  referralCode?: string;
}

const linkClass = "underline underline-offset-4 hover:text-foreground";

export function RegisterForm({ slug, termsVersion, privacyVersion, referralCode }: RegisterFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    control,
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
      referralCode,
    },
  });
  const isPJ = watch("type") === "PJ";

  const onSubmit = async (values: RegisterFormValues) => {
    setServerError(null);
    let result: Awaited<ReturnType<typeof registerClientAction>>;
    try {
      result = await registerClientAction(values);
    } catch {
      setServerError("Não foi possível concluir o cadastro. Tente novamente.");
      return;
    }
    if (result.error) {
      setServerError(result.error);
      return;
    }
    const login = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      callbackURL: "/portal",
    });
    if (login.error) {
      setServerError("Conta criada. Entre com seu e-mail e senha.");
      router.push("/login");
    }
  };

  const fieldError = (name: keyof RegisterFormValues) => {
    const message = errors[name]?.message;
    return message ? (
      <p id={`${name}-error`} className="text-base text-destructive">
        {message}
      </p>
    ) : null;
  };
  const describedBy = (name: keyof RegisterFormValues) => (errors[name] ? `${name}-error` : undefined);

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Criar conta</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <input type="hidden" {...register("referralCode")} />
          <div className="space-y-2">
            <Label htmlFor="type">Tipo de pessoa</Label>
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa física</SelectItem>
                    <SelectItem value="PJ">Pessoa jurídica</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
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
            <div className="flex items-start gap-3">
              <Controller
                control={control}
                name="acceptedTerms"
                render={({ field }) => (
                  <Checkbox
                    id="acceptedTerms"
                    className="mt-1"
                    aria-describedby={describedBy("acceptedTerms")}
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                  />
                )}
              />
              <Label htmlFor="acceptedTerms" className="text-base font-normal leading-snug">
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
          {serverError && <StatusBanner tone="attention" title={serverError} />}
          <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Criando conta..." : "Criar conta"}
          </Button>
          <div className="text-center">
            <Link href="/login" className="inline-flex min-h-12 items-center underline underline-offset-4">
              Já tenho conta
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
