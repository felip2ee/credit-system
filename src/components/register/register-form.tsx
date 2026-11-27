"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { registerClientAction } from "@/actions/register";
import { Building2, IdCard, Mail, Phone, UserRound } from "lucide-react";

import { IconInput } from "@/components/auth/icon-input";
import { PasswordInput } from "@/components/auth/password-input";
import { REGISTER_STEPS, canLeaveStep, hasTypedData, serverErrorTarget, stepOfField } from "@/components/register/register-wizard-steps";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { authClient } from "@/lib/auth/client";
import { STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import { registerFormSchema, type RegisterFormValues } from "@/lib/validators/register";

export interface RegisterFormProps {
  slug: string;
  termsVersion: number;
  privacyVersion: number;
  referralCode?: string;
}

const linkClass = "font-bold text-primary underline underline-offset-4";

// Duplo clique: só o primeiro clique age. Teclado (detail 0) e clique simples (detail 1) sempre passam.
const ignoreRepeatedClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  if (event.detail > 1) event.preventDefault();
};

// Sangra até a borda: o gutter da página é 16 px (20 px a partir de 375 px), como `.px-screen`.
const BLEED = "-mx-4 min-[375px]:-mx-5";

export function RegisterForm({ slug, termsVersion, privacyVersion, referralCode }: RegisterFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  // Destino de saída que espera a confirmação; nulo com o diálogo fechado.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  // O envio só libera depois que a última etapa assentou (duplo clique em "Continuar" não atravessa).
  const [submitReady, setSubmitReady] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(0);
  // Campo que recebe o foco quando a etapa do erro do servidor termina de montar.
  const pendingFocus = useRef<"email" | "document" | null>(null);
  const {
    register,
    control,
    handleSubmit,
    watch,
    getValues,
    trigger,
    setError,
    setFocus,
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
  const step = REGISTER_STEPS[stepIndex];
  const isLast = stepIndex === REGISTER_STEPS.length - 1;

  // Ao trocar de etapa o foco vai para o título (não na abertura: o StrictMode roda o efeito duas vezes).
  useEffect(() => {
    if (shownStep.current === stepIndex) return;
    shownStep.current = stepIndex;
    if (pendingFocus.current) {
      setFocus(pendingFocus.current);
      pendingFocus.current = null;
      return;
    }
    titleRef.current?.focus();
  }, [stepIndex, setFocus]);

  useEffect(() => {
    if (!isLast) {
      setSubmitReady(false);
      return;
    }
    const timer = setTimeout(() => setSubmitReady(true), STEP_CLICK_GUARD_MS);
    return () => clearTimeout(timer);
  }, [isLast]);

  const requestExit = (href: string) => {
    if (hasTypedData(getValues())) setLeaveTo(href);
    else router.push(href);
  };

  const goBack = () => {
    setServerError(null);
    if (stepIndex === 0) requestExit(`/b/${slug}/entrar`);
    else setStepIndex(stepIndex - 1);
  };

  const goNext = async () => {
    if (!canLeaveStep(step.id, getValues())) {
      await trigger(step.fields, { shouldFocus: true });
      return;
    }
    setServerError(null);
    setStepIndex(stepIndex + 1);
  };

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
      // E-mail ou documento em uso: vai para a etapa do campo e marca o campo.
      const target = serverErrorTarget(result.error);
      if (!target) {
        setServerError(result.error);
        return;
      }
      setError(target.field, { message: result.error });
      pendingFocus.current = target.field;
      setStepIndex(REGISTER_STEPS.findIndex((s) => s.id === target.step));
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

  // Erro em campo de outra etapa nunca é silencioso: volta para a etapa do erro.
  const onInvalid = (invalid: FieldErrors<RegisterFormValues>) => {
    const target = Object.keys(invalid).map(stepOfField).find((id) => id !== null);
    const index = REGISTER_STEPS.findIndex((s) => s.id === target);
    if (index >= 0) {
      if (index !== stepIndex) setStepIndex(index);
      return;
    }
    // Só avisa quando nenhum campo visível carrega o erro.
    setServerError("Revise os dados e tente novamente.");
  };

  // Enter nas etapas 1 e 2 avança; só a última etapa envia.
  const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isLast) return goNext();
    if (!submitReady) return;
    return handleSubmit(onSubmit, onInvalid)(event);
  };

  return (
    <section className="w-full space-y-6">
      <ScreenHeader
        className={BLEED}
        title="Criar conta"
        backLabel={stepIndex === 0 ? "Voltar para entrar" : "Voltar para a etapa anterior"}
        onBack={goBack}
        closeLabel="Sair do cadastro"
        onClose={() => requestExit(`/b/${slug}`)}
        step={{ current: stepIndex + 1, total: REGISTER_STEPS.length, label: step.label }}
      />
      <form onSubmit={onFormSubmit} onChange={() => setServerError(null)} className="space-y-5" noValidate>
        <input type="hidden" {...register("referralCode")} />
        <div key={step.id} className="space-y-5 motion-safe:animate-fade-in">
          <h2 ref={titleRef} tabIndex={-1} className="text-xl font-bold focus:outline-none">
            <span className="sr-only">
              Passo {stepIndex + 1} de {REGISTER_STEPS.length}:{" "}
            </span>
            {step.title}
          </h2>
          {step.id === "who" && (
            <>
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
            </>
          )}
          {step.id === "contact" && (
            <>
              <Field id="email" label="E-mail" error={errors.email?.message}>
                {(a) => <IconInput icon={Mail} type="email" autoComplete="email" {...a} {...register("email")} />}
              </Field>
              <Field id="phone" label="Celular (com DDD)" error={errors.phone?.message}>
                {(a) => <IconInput icon={Phone} type="tel" autoComplete="tel" {...a} {...register("phone")} />}
              </Field>
            </>
          )}
          {step.id === "access" && (
            <>
              <Field id="password" label="Senha" helper="Use pelo menos 12 caracteres." error={errors.password?.message}>
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
                {errors.acceptedTerms?.message && (
                  <p id="acceptedTerms-error" role="alert" className="text-base font-bold text-destructive">
                    {errors.acceptedTerms.message}
                  </p>
                )}
              </div>
            </>
          )}
          <p className="text-base text-muted-foreground">
            <span className="font-bold text-foreground">O que acontece depois: </span>
            {step.after}
          </p>
        </div>
        {serverError && <StatusBanner tone="attention" title={serverError} />}
        {isLast ? (
          <Button key="submit" type="submit" glow className="w-full" onClick={ignoreRepeatedClick} disabled={isSubmitting || !submitReady}>
            {isSubmitting ? "Criando conta..." : "Criar conta"}
          </Button>
        ) : (
          <Button key="next" type="submit" glow className="w-full" onClick={ignoreRepeatedClick}>
            Continuar
          </Button>
        )}
        {stepIndex === 0 && (
          <div className="text-center">
            <Link href="/login" className="inline-flex min-h-11 items-center font-bold text-primary underline-offset-4 hover:underline">
              Já tenho conta
            </Link>
          </div>
        )}
      </form>
      <Dialog open={leaveTo !== null} onClose={() => setLeaveTo(null)} title="Sair sem concluir?" role="alertdialog">
        <p className="text-base">Os dados digitados serão perdidos.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" autoFocus onClick={() => setLeaveTo(null)}>
            Continuar editando
          </Button>
          <Button type="button" variant="destructive" onClick={() => leaveTo && router.push(leaveTo)}>
            Sair
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
