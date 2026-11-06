"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { getCheckoutContextAction, type CheckoutContextResult } from "@/actions/checkout-context";
import { toCents } from "@/lib/catalog/money";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StatusBanner } from "@/components/ui/status-banner";
import type { PayerField } from "@/lib/payers/queries";
import type { CheckoutActionResult } from "@/lib/payments/checkout";
import { formatCurrency } from "@/lib/utils";
import type { CheckoutInput } from "@/lib/validators/checkout";
import type { TopupSuggestion } from "@/lib/validators/wallet";
import { parseTopupInput } from "@/lib/wallet/topup-input";

import { buildCheckoutInput, EMPTY_CARD, PAYER_FIELDS, type CardDraft, type CheckoutErrors, type Method, type PayerKind } from "./checkout-model";
import { CardPaymentForm } from "./CardPaymentForm";
import { acquireKey, checkoutFingerprint, settleKey, type KeyHolder, type SubmitOutcome } from "./checkout-key";
import { installmentLabel } from "./InstallmentSelect";
import { PayerStep } from "./PayerStep";
import { useChargePolling, type PollOutcome } from "./useChargePolling";

const CONTEXT_DEBOUNCE_MS = 400;
const EMPTY_VALUES = Object.fromEntries(PAYER_FIELDS.map((f) => [f, ""])) as Record<PayerField, string>;
const NO_EDITING: ReadonlySet<PayerField> = new Set();

type Props = {
  scope: "bureau" | "client";
  action: (input: CheckoutInput) => Promise<CheckoutActionResult>;
  /** Pix gerado: o diálogo mostra o QR (cada tela decide onde). */
  onPix: (charge: { id: string; pixPayload: string; qrImageBase64: string }) => void;
  onClose: () => void;
  suggestions?: TopupSuggestion[];
};

const OUTCOME: Record<Exclude<PollOutcome, "aborted">, { tone: "success" | "attention" | "neutral" | "waiting"; title: string; description?: string }> = {
  paid: { tone: "success", title: "Pagamento aprovado.", description: "Seu saldo foi atualizado." },
  timeout: { tone: "waiting", title: "Pagamento em análise; o saldo atualiza sozinho." },
  expired: { tone: "neutral", title: "Cobrança expirada.", description: "Nada foi creditado no saldo." },
  cancelled: { tone: "attention", title: "O pagamento não foi aprovado.", description: "Nada foi creditado no saldo. Confira os dados e tente de novo." },
  refunded: { tone: "neutral", title: "Pagamento estornado." },
};

export function CheckoutForm({ scope, action, onPix, onClose, suggestions = [] }: Props) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("PIX");
  const [kind, setKind] = useState<PayerKind>("owner");
  const [values, setValues] = useState(EMPTY_VALUES);
  const [editing, setEditing] = useState(NO_EDITING);
  const [declaration, setDeclaration] = useState(false);
  const [card, setCard] = useState<CardDraft>(EMPTY_CARD);
  const [installments, setInstallments] = useState(1);
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CheckoutContextResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const amountRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const firstLoad = useRef(true);
  const keyHolder = useRef<KeyHolder>(null);

  const polling = useChargePolling((outcome) => {
    if (outcome === "paid") router.refresh();
  });

  useEffect(() => amountRef.current?.focus(), []);

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
  const activeMethod: Method = method === "CREDIT_CARD" && cardEnabled ? "CREDIT_CARD" : "PIX";
  const selected = options.find((o) => o.installments === installments) ?? options[0];
  const parsedAmount = parseTopupInput(amount);
  const amountCents = parsedAmount.ok ? toCents(parsedAmount.amount) : 0;
  const cardUnavailable = activeMethod === "CREDIT_CARD" && options.length === 0;
  const missing = ctx?.missing?.[activeMethod] ?? [];
  const ready = ctx !== null && !ctx.error && ctx.owner !== undefined;

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
    const acquired = acquireKey(
      keyHolder.current,
      checkoutFingerprint({ amount, method: activeMethod, installments: selected?.installments ?? 1, kind }),
      () => crypto.randomUUID(),
    );
    const built = buildCheckoutInput({
      amount,
      method: activeMethod,
      kind,
      installments: selected?.installments ?? 1,
      missing,
      editing,
      values,
      card,
      declaration,
      idempotencyKey: acquired.key,
    });
    if (!built.ok) {
      setErrors(built.errors);
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
        onPix({ id: res.id, pixPayload: res.pixPayload, qrImageBase64: res.qrImageBase64 ?? "" });
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
      ? "Gerar PIX"
      : selected
        ? `Pagar ${formatCurrency(selected.totalCents / 100)} no cartão`
        : "Pagar no cartão";

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-2">
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Valores sugeridos">
            {suggestions.map((s) => (
              <Button key={s.pfCount} type="button" variant="outline" disabled={isPending} onClick={() => setAmount(s.amount.replace(".", ","))}>
                {s.pfCount} PF · {formatCurrency(Number(s.amount))}
              </Button>
            ))}
          </div>
        )}
        <Field id="topup-amount" label="Valor (R$ 10,00 a R$ 5.000,00)" error={errors.amount}>
          {(a11y) => (
            <Input {...a11y} ref={amountRef} inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isPending} />
          )}
        </Field>
      </div>

      {ctx === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Carregando dados de pagamento...
        </p>
      )}
      {ctx?.error && <StatusBanner tone="attention" title={ctx.error} />}

      {ready && ctx.owner && (
        <>
          {cardEnabled && (
            <fieldset className="space-y-2" disabled={isPending}>
              <legend className="mb-2 text-base font-bold">Forma de pagamento</legend>
              <RadioGroup value={activeMethod} onValueChange={(v) => setMethod(v as Method)} aria-label="Forma de pagamento">
                {(
                  [
                    ["PIX", "Pix"],
                    ["CREDIT_CARD", "Cartão de crédito, até 12x"],
                  ] as const
                ).map(([value, label]) => (
                  <div key={value} className="flex min-h-11 items-center gap-3">
                    <RadioGroupItem value={value} id={`method-${value}`} />
                    <Label htmlFor={`method-${value}`} className="flex-1 cursor-pointer py-2">
                      {label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
          )}

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

          {activeMethod === "CREDIT_CARD" &&
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
        <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
          Cancelar
        </Button>
        <Button type="submit" glow disabled={isPending || !ready || amount === "" || cardUnavailable}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
