"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { registerClientAction } from "@/actions/register";
import { Building2, IdCard, Mail, Phone, UserRound } from "lucide-react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { IconInput } from "@/components/auth/icon-input";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
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

const linkClass = "font-bold text-primary underline underline-offset-4";

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

  return (
    <section className="w-full space-y-8">
      <AuthHeading title="Criar conta" />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <input type="hidden" {...register("referralCode")} />
        <Field id="type" label="Tipo de pessoa">
          {(a) => (
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger {...a}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa física</SelectItem>
                    <SelectItem value="PJ">Pessoa jurídica</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          )}
        </Field>
        <Field id="name" label={isPJ ? "Razão social" : "Nome completo"} error={errors.name?.message}>
          {(a) => <IconInput icon={isPJ ? Building2 : UserRound} autoComplete={isPJ ? "organization" : "name"} {...a} {...register("name")} />}
        </Field>
        <Field id="document" label={isPJ ? "CNPJ" : "CPF"} error={errors.document?.message}>
          {(a) => <IconInput icon={IdCard} inputMode="numeric" {...a} {...register("document")} />}
        </Field>
        <Field id="email" label="E-mail" error={errors.email?.message}>
          {(a) => <IconInput icon={Mail} type="email" autoComplete="email" {...a} {...register("email")} />}
        </Field>
        <Field id="phone" label="Celular (com DDD)" error={errors.phone?.message}>
          {(a) => <IconInput icon={Phone} type="tel" autoComplete="tel" {...a} {...register("phone")} />}
        </Field>
        <Field id="password" label="Senha" error={errors.password?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("password")} />}
        </Field>
        <Field id="confirm" label="Confirmar senha" error={errors.confirm?.message}>
          {(a) => <PasswordInput withIcon {...a} {...register("confirm")} />}
        </Field>
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <Controller
              control={control}
              name="acceptedTerms"
              render={({ field }) => (
                <Checkbox
                  id="acceptedTerms"
                  className="mt-1"
                  aria-describedby={errors.acceptedTerms ? "acceptedTerms-error" : undefined}
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
          {errors.acceptedTerms?.message && (
            <p id="acceptedTerms-error" role="alert" className="text-base font-bold text-destructive">
              {errors.acceptedTerms.message}
            </p>
          )}
        </div>
        {serverError && <StatusBanner tone="attention" title={serverError} />}
        <Button type="submit" size="lg" glow className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Criando conta..." : "Criar conta"}
        </Button>
        <div className="text-center">
          <Link href="/login" className="inline-flex min-h-12 items-center font-bold text-primary underline-offset-4 hover:underline">
            Já tenho conta
          </Link>
        </div>
      </form>
    </section>
  );
}
