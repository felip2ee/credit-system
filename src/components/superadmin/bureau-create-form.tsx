"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";

import { createBureau } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import {
  BUREAU_STEPS,
  canLeaveStep,
  hasTypedData,
  STEP_FIELDS,
  stepErrors,
  type BureauCreateValues,
  type BureauField,
} from "./bureau-create-steps";

const EXIT_HREF = "/superadmin";
// Sangra até a borda do `main` (p-4 / md:p-6), como o assistente do painel.
const BLEED = "-mx-4 -mt-4 md:-mx-6 md:-mt-6";
const SLUG_HELPER =
  "Vira o endereço público /b/slug. Dá para mudar depois na edição do Bureau: o link antigo continua funcionando e leva ao novo.";

// Duplo clique: só o primeiro clique age. Teclado (detail 0) e clique simples (detail 1) sempre passam.
const ignoreRepeatedClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  if (event.detail > 1) event.preventDefault();
};

export function BureauCreateForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [stepIndex, setStepIndex] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createdWithPassword, setCreatedWithPassword] = useState(false);
  // A criação só libera depois que a etapa assentou: um duplo clique em "Continuar" não a atravessa.
  const [createReady, setCreateReady] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(0);

  const {
    register,
    getValues,
    resetField,
    setError,
    clearErrors,
    setFocus,
    formState: { errors },
  } = useForm<BureauCreateValues>({
    defaultValues: { name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "", confirm: "" },
  });

  const step = BUREAU_STEPS[stepIndex];
  const isLast = stepIndex === BUREAU_STEPS.length - 1;
  const created = createdId !== null;

  // Ao trocar de etapa o foco vai para o título, para o leitor de tela anunciar onde está.
  useEffect(() => {
    if (shownStep.current === stepIndex) return;
    shownStep.current = stepIndex;
    titleRef.current?.focus();
  }, [stepIndex]);

  useEffect(() => {
    if (!isLast) {
      setCreateReady(false);
      return;
    }
    const timer = setTimeout(() => setCreateReady(true), STEP_CLICK_GUARD_MS);
    return () => clearTimeout(timer);
  }, [isLast]);

  const requestExit = () => {
    if (!created && hasTypedData(getValues())) setLeaveOpen(true);
    else router.push(EXIT_HREF);
  };

  const goBack = () => {
    if (stepIndex === 0) requestExit();
    else setStepIndex(stepIndex - 1);
  };

  // Mostra os erros da etapa ligados aos campos e põe o foco no primeiro inválido. Devolve true se não há erro.
  const checkStep = (target: typeof step): boolean => {
    clearErrors(STEP_FIELDS[target.id]);
    if (canLeaveStep(target.id, getValues())) return true;
    const found = stepErrors(target.id, getValues());
    const fields = STEP_FIELDS[target.id].filter((f) => found[f]);
    for (const field of fields) setError(field, { message: found[field] });
    setFocus(fields[0]);
    return false;
  };

  const goNext = () => {
    if (!checkStep(step)) return;
    setServerError(null);
    setStepIndex(stepIndex + 1);
  };

  // O servidor recusa slug e e-mail em uso: leva o erro ao campo, na etapa dele.
  const showServerError = (message: string) => {
    if (message.includes("(slug)")) {
      setStepIndex(0);
      setError("slug", { message });
      setTimeout(() => setFocus("slug"), 0);
      return;
    }
    if (message === "Este e-mail já pertence a outro usuário.") {
      setError("adminEmail", { message });
      setFocus("adminEmail");
      return;
    }
    setServerError(message);
  };

  const submit = () => {
    // Revalida as duas etapas: erro em campo de outra etapa nunca pode ser silencioso.
    const firstInvalid = BUREAU_STEPS.findIndex((s) => !canLeaveStep(s.id, getValues()));
    if (firstInvalid >= 0) {
      setStepIndex(firstInvalid);
      setTimeout(() => checkStep(BUREAU_STEPS[firstInvalid]), 0);
      return;
    }
    const { confirm: _confirm, adminPassword, ...rest } = getValues();
    const values = { ...rest, adminPassword: adminPassword || undefined };
    setServerError(null);
    setCreatedWithPassword(false);
    startTransition(async () => {
      const result = await createBureau(values);
      resetField("adminPassword");
      resetField("confirm");
      if (result.error) {
        // Bureau criado, e-mail falhou: o usuário segue para reenviar o convite.
        if (result.id) {
          setCreatedId(result.id);
          setServerError(result.error);
        } else {
          showServerError(result.error);
        }
        return;
      }
      if (values.adminPassword) {
        // Com senha, a página fica para mostrar o aviso (sem repetir a senha).
        setCreatedId(result.id ?? null);
        setCreatedWithPassword(true);
        return;
      }
      router.push(`/superadmin/bureaus/${result.id}`);
    });
  };

  const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (created) return;
    if (!isLast) return goNext();
    if (!createReady) return;
    submit();
  };

  const err = (field: BureauField) => errors[field]?.message ?? null;

  return (
    <div className="space-y-6">
      <ScreenHeader
        className={BLEED}
        title="Novo Bureau"
        onBack={goBack}
        backLabel={stepIndex === 0 ? "Voltar para a lista de Bureaus" : "Voltar para a etapa anterior"}
        onClose={requestExit}
        closeLabel="Fechar e voltar para a lista de Bureaus"
        step={{ current: stepIndex + 1, total: BUREAU_STEPS.length, label: step.label }}
      />
      <form onSubmit={onFormSubmit} noValidate className="mx-auto w-full max-w-xl space-y-4">
        <section key={step.id} className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
          <h2 ref={titleRef} tabIndex={-1} className="text-base font-bold focus:outline-none">
            <span className="sr-only">
              Passo {stepIndex + 1} de {BUREAU_STEPS.length}:{" "}
            </span>
            {step.title}
          </h2>
          {step.id === "bureau" && (
            <>
              <Field id="name" label="Nome do Bureau" error={err("name")}>
                {(a11y) => <Input {...a11y} autoComplete="organization" {...register("name")} />}
              </Field>
              <Field id="slug" label="Endereço (slug)" helper={SLUG_HELPER} error={err("slug")}>
                {(a11y) => <Input {...a11y} placeholder="meu-bureau" autoCapitalize="none" {...register("slug")} />}
              </Field>
            </>
          )}
          {step.id === "admin" && (
            <>
              <Field id="adminName" label="Nome do administrador" error={err("adminName")}>
                {(a11y) => <Input {...a11y} autoComplete="off" {...register("adminName")} />}
              </Field>
              <Field id="adminEmail" label="E-mail do administrador" error={err("adminEmail")}>
                {(a11y) => <Input {...a11y} type="email" autoComplete="off" {...register("adminEmail")} />}
              </Field>
              <Field
                id="adminPassword"
                label="Senha do administrador (opcional)"
                helper="Em branco: o administrador recebe um convite por e-mail e cria a própria senha. Com senha: ele entra direto e troca a senha no primeiro acesso. Informe a senha a ele por um canal seguro."
                error={err("adminPassword")}
              >
                {(a11y) => <PasswordInput {...a11y} {...register("adminPassword")} />}
              </Field>
              <Field id="confirm" label="Confirmar senha" error={err("confirm")}>
                {(a11y) => <PasswordInput {...a11y} {...register("confirm")} />}
              </Field>
            </>
          )}
          <p className="text-sm text-muted-foreground">
            <span className="font-bold text-foreground">O que acontece depois: </span>
            {step.after}
          </p>
        </section>

        <div aria-live="polite" className="space-y-3">
          {createdWithPassword && (
            <StatusBanner tone="success" title="Bureau criado. Informe a senha ao administrador por um canal seguro." />
          )}
          {serverError && <StatusBanner tone={created ? "attention" : "danger"} title={serverError} />}
          {created && (
            <Button asChild>
              <Link href={`/superadmin/bureaus/${createdId}`}>Abrir o Bureau criado</Link>
            </Button>
          )}
        </div>

        {!created &&
          (!isLast ? (
            <Button key="next" type="submit" onClick={ignoreRepeatedClick}>
              Continuar
            </Button>
          ) : (
            <Button key="create" type="submit" onClick={ignoreRepeatedClick} disabled={isPending || !createReady}>
              {isPending ? "Criando..." : "Criar Bureau"}
            </Button>
          ))}
      </form>
      <Dialog open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Sair sem concluir?" role="alertdialog">
        <p className="text-base">Os dados digitados serão perdidos e o Bureau não será criado.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" autoFocus onClick={() => setLeaveOpen(false)}>
            Continuar editando
          </Button>
          <Button type="button" variant="destructive" onClick={() => router.push(EXIT_HREF)}>
            Sair
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
