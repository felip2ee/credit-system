"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestWithdrawalAction } from "@/actions/affiliate-withdrawals";
import { isStepSettled } from "@/components/orders/order-wizard-steps";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { failureMessage } from "@/lib/ui/failure-message";
import { formatCurrency } from "@/lib/utils";

import { withdrawalPreview, type WithdrawalFee } from "./affiliate-rules";
import { amountStepError, keyStepErrors, WITHDRAWAL_STEPS, type KeyStepErrors, type WithdrawalStepId } from "./withdrawal-steps";

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

  const stepIndex = WITHDRAWAL_STEPS.findIndex((s) => s.id === step);
  const current = WITHDRAWAL_STEPS[stepIndex];

  // O foco vai ao título da etapa (não na abertura da tela).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepChangedAt.current = Date.now();
    titleRef.current?.focus();
  }, [step]);

  function goToKey() {
    const message = amountStepError(amount, fee);
    setAmountError(message);
    if (!message) setStep("key");
  }

  function request() {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const result = await requestWithdrawalAction({ amount, pixKeyType, pixKey, ownKeyDeclaration: ownKey });
      if (result.error) {
        setError(result.error);
        return;
      }
      setDone(true);
      setAmount("");
      setPixKey("");
      setOwnKey(false);
      setStep("amount");
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
    // Um duplo clique em "Continuar" não pode confirmar o saque na etapa seguinte.
    if (!isStepSettled(stepChangedAt.current, Date.now())) return;
    const errors = keyStepErrors(pixKey, ownKey);
    setKeyErrors(errors);
    if (Object.keys(errors).length > 0) return;
    request();
  }

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
      {done && <StatusBanner tone="success" title="Saque solicitado." description="Você será avisado quando o pagamento sair." />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {step === "key" && (
          <Button type="button" variant="outline" onClick={() => setStep("amount")} disabled={pending}>
            Voltar
          </Button>
        )}
        <Button type="submit" glow disabled={pending}>
          {step === "amount" ? "Continuar" : pending ? "Enviando..." : "Solicitar saque"}
        </Button>
      </div>
    </form>
  );
}

function WithdrawalFailure({ what }: { what: string }) {
  const msg = failureMessage({ what, money: "not_charged", next: "Confira os dados e tente de novo." });
  return (
    <StatusBanner
      tone="attention"
      title={msg.title}
      description={
        <>
          <p>{msg.money}</p>
          <p>{msg.next}</p>
        </>
      }
    />
  );
}
