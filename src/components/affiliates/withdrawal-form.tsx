"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestWithdrawalAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { failureMessage } from "@/lib/ui/failure-message";
import { isStepSettled, STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import { formatCurrency } from "@/lib/utils";

import { withdrawalPreview, type WithdrawalFee } from "./affiliate-rules";
import {
  amountStepError,
  isAmountFailure,
  keyStepErrors,
  WITHDRAWAL_STEPS,
  withdrawalFailure,
  type KeyStepErrors,
  type WithdrawalStepId,
} from "./withdrawal-steps";

const KEY_TYPES = [
  { value: "document", label: "CPF ou CNPJ" },
  { value: "email", label: "E-mail" },
  { value: "phone", label: "Celular" },
  { value: "random", label: "Chave aleatória" },
] as const;

type KeyType = (typeof KEY_TYPES)[number]["value"];

interface WithdrawalFormProps {
  fee: WithdrawalFee;
}

export function WithdrawalForm({ fee }: WithdrawalFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<WithdrawalStepId>("amount");
  const [amount, setAmount] = useState("");
  const [pixKeyType, setPixKeyType] = useState<KeyType>("document");
  const [pixKey, setPixKey] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [keyErrors, setKeyErrors] = useState<KeyStepErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const preview = useMemo(() => withdrawalPreview(amount, fee), [amount, fee]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepChangedAt = useRef(Date.now());
  const firstRender = useRef(true);
  // Id do campo que recebe o foco depois da próxima troca de etapa (senão, o título).
  const focusAfterStep = useRef<string | null>(null);
  // O botão que confirma o saque só vale depois do tempo de guarda: um duplo clique em "Continuar" não o atinge.
  const [confirmReady, setConfirmReady] = useState(false);

  const stepIndex = WITHDRAWAL_STEPS.findIndex((s) => s.id === step);
  const current = WITHDRAWAL_STEPS[stepIndex];

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepChangedAt.current = Date.now();
    setConfirmReady(false);
    const timer = setTimeout(() => setConfirmReady(true), STEP_CLICK_GUARD_MS);
    const target = focusAfterStep.current ? document.getElementById(focusAfterStep.current) : null;
    focusAfterStep.current = null;
    (target ?? titleRef.current)?.focus();
    return () => clearTimeout(timer);
  }, [step]);

  const focusField = (id: string) => document.getElementById(id)?.focus();

  function moveTo(next: WithdrawalStepId) {
    setError(null);
    setStep(next);
  }

  function goToKey() {
    const message = amountStepError(amount, fee);
    setAmountError(message);
    if (message) focusField("withdraw-amount");
    else moveTo("key");
  }

  function request() {
    setError(null);
    setDone(false);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof requestWithdrawalAction>>;
      try {
        result = await requestWithdrawalAction({ amount, pixKeyType, pixKey, ownKeyDeclaration: ownKey });
      } catch {
        // Sem resposta: o saque pode ter sido criado. O texto cai no aviso neutro.
        setError("Falha ao solicitar o saque.");
        return;
      }
      if (result.error) {
        if (isAmountFailure(result.error)) {
          // Recusa por valor: volta à etapa do valor, com a mensagem no campo.
          setAmountError(result.error);
          focusAfterStep.current = "withdraw-amount";
          moveTo("amount");
          return;
        }
        setError(result.error);
        return;
      }
      setDone(true);
      setAmount("");
      setPixKey("");
      setOwnKey(false);
      moveTo("amount");
      router.refresh();
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (step === "amount") {
      goToKey();
      return;
    }
    // Segunda barreira, além do botão desabilitado: nada de confirmar logo depois de trocar de etapa (Enter, por exemplo).
    if (!confirmReady || !isStepSettled(stepChangedAt.current, Date.now())) return;
    const errors = keyStepErrors(pixKey, ownKey);
    setKeyErrors(errors);
    if (errors.pixKey) focusField("withdraw-key");
    else if (errors.ownKey) focusField("withdraw-own-key");
    if (Object.keys(errors).length > 0) return;
    request();
  }

  // Segundo clique de um duplo clique de verdade: ignora (teclado tem detail 0 e passa).
  const ignoreDoubleClick = (event: React.MouseEvent) => {
    if (event.detail > 1) event.preventDefault();
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Passo {stepIndex + 1} de {WITHDRAWAL_STEPS.length}: {current.label}
        </p>
        <h2 ref={titleRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          {current.title}
        </h2>
      </div>
      <div key={step} className="space-y-4 motion-safe:animate-fade-in">
        {step === "amount" ? (
          <>
            <Field
              id="withdraw-amount"
              label="Valor (R$)"
              helper={`Taxa de saque: ${formatCurrency(Number(fee.fixed))} + ${fee.percent}%`}
              error={amountError}
            >
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setAmountError(null);
                  }}
                  disabled={pending}
                />
              )}
            </Field>
            {amount !== "" && preview.valid && (
              <p className="tabular-nums" aria-live="polite">
                {`Taxa ${formatCurrency(Number(preview.fee))}. Você recebe ${formatCurrency(Number(preview.net))}.`}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="rounded-card border border-border bg-muted p-3 tabular-nums">
              Saque de {formatCurrency(Number(amount))}. Taxa {formatCurrency(Number(preview.fee))}. Você recebe{" "}
              <span className="font-bold">{formatCurrency(Number(preview.net))}</span>.
            </p>
            <Field id="withdraw-key-type" label="Tipo da chave PIX">
              {(a11y) => (
                <Select value={pixKeyType} onValueChange={(v) => setPixKeyType(v as KeyType)} disabled={pending}>
                  <SelectTrigger {...a11y}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KEY_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field id="withdraw-key" label="Chave PIX" error={keyErrors.pixKey}>
              {(a11y) => (
                <Input
                  {...a11y}
                  value={pixKey}
                  onChange={(e) => {
                    setPixKey(e.target.value);
                    setKeyErrors((prev) => ({ ...prev, pixKey: undefined }));
                  }}
                  disabled={pending}
                  autoComplete="off"
                  // Enter não pede o saque (dinheiro): nesta etapa, só o botão confirma.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                />
              )}
            </Field>
            <div className="space-y-1">
              <div className="flex min-h-11 items-center gap-3">
                <Checkbox
                  id="withdraw-own-key"
                  checked={ownKey}
                  aria-invalid={keyErrors.ownKey ? true : undefined}
                  aria-describedby={keyErrors.ownKey ? "withdraw-own-key-error" : undefined}
                  onCheckedChange={(checked) => {
                    setOwnKey(checked === true);
                    setKeyErrors((prev) => ({ ...prev, ownKey: undefined }));
                  }}
                  disabled={pending}
                />
                <Label htmlFor="withdraw-own-key" className="cursor-pointer text-base font-normal">
                  A chave PIX está no meu nome
                </Label>
              </div>
              {keyErrors.ownKey && (
                <p id="withdraw-own-key-error" role="alert" className="text-sm font-bold text-destructive">
                  {keyErrors.ownKey}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground">O que acontece depois: {current.after}</p>
      {error && <WithdrawalFailure what={error} />}
      {done && <StatusBanner tone="success" title="Saque solicitado." description='O pedido entra na fila. Acompanhe o status em "Seus saques".' />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {step === "key" && (
          <Button type="button" variant="outline" onClick={() => moveTo("amount")} disabled={pending}>
            Voltar
          </Button>
        )}
        {step === "amount" ? (
          <Button key="continue" type="submit" glow onClick={ignoreDoubleClick}>
            Continuar
          </Button>
        ) : (
          <Button key="confirm" type="submit" glow onClick={ignoreDoubleClick} disabled={pending || !confirmReady}>
            {pending ? "Enviando..." : "Solicitar saque"}
          </Button>
        )}
      </div>
    </form>
  );
}

function WithdrawalFailure({ what }: { what: string }) {
  const msg = failureMessage({ what, ...withdrawalFailure(what) });
  return (
    <StatusBanner
      tone="attention"
      title={msg.title}
      description={
        <>
          {msg.money && <p>{msg.money}</p>}
          {msg.next && <p>{msg.next}</p>}
        </>
      }
    />
  );
}
