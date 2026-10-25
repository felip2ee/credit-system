"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestWithdrawalAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { failureMessage } from "@/lib/ui/failure-message";
import { formatCurrency } from "@/lib/utils";

import { withdrawalPreview, type WithdrawalFee } from "./affiliate-rules";

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
  const [amount, setAmount] = useState("");
  const [pixKeyType, setPixKeyType] = useState<KeyType>("document");
  const [pixKey, setPixKey] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const preview = useMemo(() => withdrawalPreview(amount, fee), [amount, fee]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
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
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-base text-muted-foreground">
        Taxa de saque: {formatCurrency(Number(fee.fixed))} + {fee.percent}%
      </p>
      <div className="space-y-1">
        <Label htmlFor="withdraw-amount">Valor (R$)</Label>
        <Input id="withdraw-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} />
        {amount !== "" && (
          <p className={preview.valid ? "tabular-nums" : "font-bold text-destructive"}>
            {preview.valid
              ? `Taxa ${formatCurrency(Number(preview.fee))}. Você recebe ${formatCurrency(Number(preview.net))}.`
              : "Informe um valor maior que a taxa de saque."}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="withdraw-key-type">Tipo da chave PIX</Label>
        <Select value={pixKeyType} onValueChange={(v) => setPixKeyType(v as KeyType)} disabled={pending}>
          <SelectTrigger id="withdraw-key-type">
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
      </div>
      <div className="space-y-1">
        <Label htmlFor="withdraw-key">Chave PIX</Label>
        <Input id="withdraw-key" value={pixKey} onChange={(e) => setPixKey(e.target.value)} disabled={pending} autoComplete="off" />
      </div>
      <div className="flex min-h-12 items-center gap-3">
        <Checkbox id="withdraw-own-key" checked={ownKey} onCheckedChange={(checked) => setOwnKey(checked === true)} disabled={pending} />
        <Label htmlFor="withdraw-own-key" className="cursor-pointer text-base font-normal">
          A chave PIX está no meu nome
        </Label>
      </div>
      {error && <WithdrawalFailure what={error} />}
      {done && <StatusBanner tone="success" title="Saque solicitado." description="Você será avisado quando o pagamento sair." />}
      <Button type="submit" size="lg" glow className="w-full sm:w-auto" disabled={pending || !ownKey || !preview.valid}>
        {pending ? "Enviando..." : "Solicitar saque"}
      </Button>
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
