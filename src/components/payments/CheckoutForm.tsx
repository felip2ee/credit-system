"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";

import { getCheckoutContextAction, type CheckoutContextResult } from "@/actions/checkout-context";
import { toCents } from "@/lib/catalog/money";
import type { ReferencePriceRow } from "@/lib/catalog/reference-prices";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import type { PayerField } from "@/lib/payers/queries";
import type { CheckoutActionResult } from "@/lib/payments/checkout";
import type { ChargeSummary } from "@/lib/wallet/pix-fees";
import { formatCurrency } from "@/lib/utils";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { parseTopupInput } from "@/lib/wallet/topup-input";

import { buildCheckoutInput, EMPTY_CARD, PAYER_FIELDS, type CardDraft, type CheckoutErrors, type Method, type PayerKind } from "./checkout-model";
import { AmountStep } from "./AmountStep";
import { CardPaymentForm } from "./CardPaymentForm";
import { acquireKey, checkoutFingerprint, settleKey, type KeyHolder, type SubmitOutcome } from "./checkout-key";
import { pixSubmitLabel, pixSummaryFor, pixSummaryLine, unavailableMessage } from "./checkout-summary";
import { advance, firstStepWithErrors, previousStep, STEP_TITLE, stepsFor, submitAction, type Step } from "./checkout-steps";
import { installmentLabel } from "./InstallmentSelect";
import { MethodStep } from "./MethodStep";
import { PayerStep } from "./PayerStep";
import { useChargePolling, type PollOutcome } from "./useChargePolling";

const CONTEXT_DEBOUNCE_MS = 400;
const EMPTY_VALUES = Object.fromEntries(PAYER_FIELDS.map((f) => [f, ""])) as Record<PayerField, string>;
const NO_EDITING: ReadonlySet<PayerField> = new Set();

type Props = {
  scope: "bureau" | "client";
  action: (input: CheckoutInput) => Promise<CheckoutActionResult>;
  /** Pix gerado: o diálogo mostra o QR (cada tela decide onde). */
  onPix: (charge: { id: string; pixPayload: string; qrImageBase64: string; summary?: ChargeSummary }) => void;
  onClose: () => void;
  /** Preços de referência dos dossiês (só no fluxo do cliente). */
  priceRows?: ReferencePriceRow[];
};

const OUTCOME: Record<Exclude<PollOutcome, "aborted">, { tone: "success" | "attention" | "neutral" | "waiting"; title: string; description?: string }> = {
  paid: { tone: "success", title: "Pagamento aprovado.", description: "Seu saldo foi atualizado." },
  timeout: { tone: "waiting", title: "Pagamento em análise; o saldo atualiza sozinho." },
  expired: { tone: "neutral", title: "Cobrança expirada.", description: "Nada foi creditado no saldo." },
  cancelled: { tone: "attention", title: "O pagamento não foi aprovado.", description: "Nada foi creditado no saldo. Confira os dados e tente de novo." },
  refunded: { tone: "neutral", title: "Pagamento estornado." },
};

export function CheckoutForm({ scope, action, onPix, onClose, priceRows = [] }: Props) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("PIX");
  const [kind, setKind] = useState<PayerKind>("owner");
  const [values, setValues] = useState(EMPTY_VALUES);
  const [editing, setEditing] = useState(NO_EDITING);
  const [declaration, setDeclaration] = useState(false);
  const [card, setCard] = useState<CardDraft>(EMPTY_CARD);
  const [installments, setInstallments] = useState(1);
  const [step, setStep] = useState<Step>("amount");
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CheckoutContextResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const amountRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prevStep = useRef<Step>("amount");
  const requestSeq = useRef(0);
  const firstLoad = useRef(true);
  const keyHolder = useRef<KeyHolder>(null);

  const polling = useChargePolling((outcome) => {
    if (outcome === "paid") router.refresh();
  });

  useEffect(() => amountRef.current?.focus(), []);

  // A cada troca de etapa o foco vai ao título (não na abertura, que foca o valor).
  useEffect(() => {
    if (prevStep.current !== step) headingRef.current?.focus();
    prevStep.current = step;
  }, [step]);

  // Ao abrir e quando o valor muda (as parcelas dependem dele).
  useEffect(() => {
    const parsed = parseTopupInput(amount);
    const delay = firstLoad.current ? 0 : CONTEXT_DEBOUNCE_MS;
    firstLoad.current = false;
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      const result = await getCheckoutContextAction({ scope, amount: parsed.ok ? parsed.amount : amount }).catch(
        (): CheckoutContextResult => ({ error: "Não foi possível carregar os dados de pagamento. Tente novamente." }),
      );
      if (seq === requestSeq.current) setCtx(result);
    }, delay);
    return () => clearTimeout(timer);
  }, [amount, scope]);

  const options = ctx?.installmentOptions ?? [];
  const cardEnabled = ctx?.cardEnabled === true;
  const pixDisabled = ctx?.pixEnabled === false;
  const activeMethod: Method = cardEnabled && (method === "CREDIT_CARD" || pixDisabled) ? "CREDIT_CARD" : "PIX";
  const noMethod = pixDisabled && !cardEnabled;
  const unavailable = ctx ? unavailableMessage(!pixDisabled, cardEnabled) : null;
  const selected = options.find((o) => o.installments === installments) ?? options[0];
  const parsedAmount = parseTopupInput(amount);
  const amountCents = parsedAmount.ok ? toCents(parsedAmount.amount) : 0;
  const pixSummary = activeMethod === "PIX" ? pixSummaryFor(ctx?.pixCharge, amountCents) : null;
  const cardUnavailable = activeMethod === "CREDIT_CARD" && options.length === 0;
  const missing = ctx?.missing?.[activeMethod] ?? [];
  const ready = ctx !== null && !ctx.error && ctx.owner !== undefined;
  const steps = stepsFor(cardEnabled, activeMethod);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const isLast = stepIndex === steps.length - 1;

  const draft = (idempotencyKey: string) =>
    buildCheckoutInput({
      amount,
      method: activeMethod,
      kind,
      installments: selected?.installments ?? 1,
      missing,
      editing,
      values,
      card,
      declaration,
      idempotencyKey,
    });

  const goBack = () => {
    setErrors({});
    setSubmitError(null);
    setStep(previousStep(steps, step));
  };

  // Avança só se a etapa atual não tem erro; os erros das etapas seguintes ficam para quando chegarem lá.
  const goNext = () => {
    const built = draft("");
    const found = built.ok ? {} : built.errors;
    const result = advance(steps, step, found);
    setErrors(result.errors);
    setStep(result.step);
  };

  const changeKind = (next: PayerKind) => {
    setKind(next);
    setValues(EMPTY_VALUES);
    setEditing(NO_EDITING);
    setDeclaration(false);
    setErrors({});
  };

  const toggleEdit = (field: PayerField) => {
    setEditing((prev) => {
      const next = new Set(prev);
      if (!next.delete(field)) next.add(field);
      return next;
    });
    setValues((prev) => ({ ...prev, [field]: "" }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitAction(steps, step) === "next") {
      goNext();
      return;
    }
    const acquired = acquireKey(
      keyHolder.current,
      checkoutFingerprint({ amount, method: activeMethod, installments: selected?.installments ?? 1, kind }),
      () => crypto.randomUUID(),
    );
    const built = draft(acquired.key);
    if (!built.ok) {
      setErrors(built.errors);
      const back = firstStepWithErrors(steps, built.errors);
      if (back) setStep(back);
      return;
    }
    setErrors({});
    setSubmitError(null);
    keyHolder.current = acquired.holder;
    // O cartão sai do estado no envio: o valor segue só dentro de `built.input`.
    setCard(EMPTY_CARD);
    startTransition(async () => {
      let networkFailed = false;
      const res = await action(built.input).catch((): CheckoutActionResult => {
        networkFailed = true;
        return { error: "Não foi possível concluir o pagamento. Tente novamente." };
      });
      const outcome: SubmitOutcome = networkFailed || res.reused ? "unknown" : res.error || !res.id ? "rejected" : "succeeded";
      keyHolder.current = settleKey(keyHolder.current, outcome);
      if (res.error || !res.id) {
        setSubmitError(res.error ?? "Não foi possível concluir o pagamento. Tente novamente.");
        return;
      }
      if (res.method === "PIX" && res.pixPayload && !res.reused) {
        onPix({ id: res.id, pixPayload: res.pixPayload, qrImageBase64: res.qrImageBase64 ?? "", summary: res.summary });
        return;
      }
      polling.start(res.id);
    });
  };

  if (polling.state.phase !== "idle") {
    const done = polling.state.phase === "done" ? polling.state.outcome : null;
    const view = done && done !== "aborted" ? OUTCOME[done] : null;
    return (
      <div className="space-y-4">
        <div aria-live="polite">
          {view ? (
            <StatusBanner tone={view.tone} title={view.title} description={view.description} />
          ) : (
            <StatusBanner tone="progress" title="Processando o pagamento..." description="Isso leva alguns segundos. Não feche esta tela." />
          )}
        </div>
        {view && (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Fechar
            </Button>
          </div>
        )}
      </div>
    );
  }

  const submitLabel = isPending
    ? "Processando..."
    : activeMethod === "PIX"
      ? pixSubmitLabel(pixSummary)
      : selected
        ? `Pagar ${formatCurrency(selected.totalCents / 100)} no cartão`
        : "Pagar no cartão";

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Etapa {stepIndex + 1} de {steps.length}
          </p>
          <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold outline-none">
            {STEP_TITLE[step]}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          aria-label="Fechar"
          className="-mr-2 -mt-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      {step === "amount" && (
        <AmountStep priceRows={priceRows} amount={amount} onAmountChange={setAmount} onPick={(v) => { setAmount(v); amountRef.current?.focus(); }} error={errors.amount} disabled={isPending} amountRef={amountRef} />
      )}

      {ctx === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Carregando dados de pagamento...
        </p>
      )}
      {ctx?.error && <StatusBanner tone="attention" title={ctx.error} />}

      {ready && ctx.owner && (
        <>
          {step === "method" && <MethodStep value={activeMethod} onChange={setMethod} pixDisabled={pixDisabled} disabled={isPending} />}

          {unavailable && <StatusBanner tone="attention" title={unavailable} />}

          {step === "payer" && (
            <>
              <PayerStep
                owner={ctx.owner}
                missing={missing}
                kind={kind}
                onKindChange={changeKind}
                values={values}
                onValueChange={(field, v) => setValues((prev) => ({ ...prev, [field]: v }))}
                editing={editing}
                onToggleEdit={toggleEdit}
                declaration={declaration}
                onDeclarationChange={setDeclaration}
                errors={errors}
                disabled={isPending}
              />
              {pixSummary && (
                <p aria-live="polite" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
                  {pixSummaryLine(pixSummary)}
                </p>
              )}
            </>
          )}

          {step === "card" &&
            (cardUnavailable ? (
              <StatusBanner tone="neutral" title="Informe um valor válido para ver as parcelas." />
            ) : (
              <>
                <CardPaymentForm
                  card={card}
                  onChange={setCard}
                  options={options}
                  installments={selected?.installments ?? 1}
                  onInstallmentsChange={setInstallments}
                  errors={errors}
                  disabled={isPending}
                />
                {selected && selected.totalCents > amountCents && (
                  <p className="text-sm text-muted-foreground">
                    {installmentLabel(selected)}. A taxa do cartão é paga por você.
                  </p>
                )}
              </>
            ))}
        </>
      )}

      {submitError && <StatusBanner tone="attention" title={submitError} />}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {stepIndex > 0 && (
          <Button type="button" variant="outline" onClick={goBack} disabled={isPending}>
            Voltar
          </Button>
        )}
        <Button type="submit" glow disabled={isPending || !ready || amount === "" || (isLast && (cardUnavailable || noMethod))}>
          {isLast ? submitLabel : "Continuar"}
        </Button>
      </div>
    </form>
  );
}
