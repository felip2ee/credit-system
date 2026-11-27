"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { registerCounterPaymentAction } from "@/actions/counter-payments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { moneyError, normalizeMoney } from "@/lib/catalog/money-input";
import type { OrderState } from "@/lib/orders/types";
import { formatCurrency, todayInSaoPaulo } from "@/lib/utils";
import { COUNTER_METHODS } from "@/lib/validators/counter-payments";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const METHOD_LABEL: Record<(typeof COUNTER_METHODS)[number], string> = {
  cash: "Dinheiro",
  pix: "PIX",
  card_machine: "Maquininha de cartão",
  transfer: "Transferência",
  other: "Outro",
};


interface CounterPaymentFormProps {
  dossierId: string;
  // Nome do titular do pedido que recebe o pagamento.
  holderName: string;
  // Quanto falta receber, em centavos; null quando o pedido ainda não tem preço.
  remainingCents: number | null;
  // O servidor só registra pagamento de pedido em awaiting_payment; null quando não há pedido.
  orderState: OrderState | null;
}

// Dinheiro: Enter num campo não registra o pagamento; só o botão envia.
export function blockImplicitSubmit(event: Pick<React.KeyboardEvent, "key" | "target" | "preventDefault">): void {
  if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") event.preventDefault();
}

export function CounterPaymentForm({ dossierId, holderName, remainingCents, orderState }: CounterPaymentFormProps) {
  const router = useRouter();
  const [method, setMethod] = useState<(typeof COUNTER_METHODS)[number]>("cash");
  const [amount, setAmount] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayInSaoPaulo);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Barreira síncrona: dois cliques seguidos entram antes de isPending virar true.
  const sending = useRef(false);

  const amountError = amount === "" ? null : moneyError(amount);
  const typedAmount = amount !== "" && !amountError ? formatCurrency(Number(normalizeMoney(amount))) : null;
  const expected =
    remainingCents === null ? "Este pedido ainda não tem preço." : remainingCents > 0 ? `Falta receber ${formatCurrency(remainingCents / 100)}.` : "Não há valor a receber.";

  // Segundo clique de um duplo clique de verdade: ignora (teclado tem detail 0 e passa).
  const ignoreDoubleClick = (event: React.MouseEvent) => {
    if (event.detail > 1) event.preventDefault();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (sending.current) return;
    const invalid = moneyError(amount);
    if (invalid) {
      setAmountInvalid(true);
      setError(invalid);
      return;
    }
    setError(null);
    setAmountInvalid(false);
    sending.current = true;
    startTransition(async () => {
      const res = await registerCounterPaymentAction({
        dossierId,
        method,
        amount: normalizeMoney(amount),
        receivedAt,
        note: note || null,
      }).finally(() => {
        sending.current = false;
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setAmount("");
      setNote("");
      router.refresh();
    });
  };

  if (orderState !== "awaiting_payment") {
    return <StatusBanner tone="neutral" title="Este pedido não aguarda pagamento." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registrar pagamento</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} onKeyDown={blockImplicitSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cp-method">Forma de pagamento</Label>
            <Select value={method} onValueChange={(value) => setMethod(value as typeof method)} disabled={isPending}>
              <SelectTrigger id="cp-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTER_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-amount">Valor (R$)</Label>
            <Input
              id="cp-amount"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isPending}
              aria-invalid={amountInvalid}
              aria-describedby={amountInvalid ? "cp-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-date">Data de recebimento</Label>
            <Input
              id="cp-date"
              type="date"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              disabled={isPending}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-note">Observação (opcional)</Label>
            <Input
              id="cp-note"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isPending}
            />
          </div>
          {error && (
            <p id="cp-error" role="alert" className="text-sm text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="space-y-2 rounded-card bg-muted p-4 text-base sm:col-span-2">
            <p>
              Pedido de <strong>{holderName}</strong>. {expected}
            </p>
            <p>
              {typedAmount ? (
                <>
                  Você vai registrar <strong>{typedAmount}</strong> em {METHOD_LABEL[method]}.
                </>
              ) : (
                "Digite o valor recebido para ver o resumo."
              )}
            </p>
            <p className="text-muted-foreground">
              O que acontece depois: o pagamento entra na lista abaixo e a situação do pedido é atualizada. Se errar, você pode anular com um motivo.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" onClick={ignoreDoubleClick} disabled={isPending || amount === ""}>
              {isPending ? "Registrando..." : "Registrar pagamento"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
