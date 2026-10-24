"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requestWithdrawalAction } from "@/actions/affiliate-withdrawals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <p className="text-sm text-muted-foreground">
        Taxa de saque: {formatCurrency(Number(fee.fixed))} + {fee.percent}%
      </p>
      <div className="space-y-1">
        <Label htmlFor="withdraw-amount">Valor (R$)</Label>
        <Input id="withdraw-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} />
        {amount !== "" && (
          <p className={preview.valid ? "text-sm" : "text-sm text-destructive"}>
            {preview.valid
              ? `Taxa ${formatCurrency(Number(preview.fee))}. Você recebe ${formatCurrency(Number(preview.net))}.`
              : "Informe um valor maior que a taxa de saque."}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="withdraw-key-type">Tipo da chave PIX</Label>
        <select
          id="withdraw-key-type"
          value={pixKeyType}
          onChange={(e) => setPixKeyType(e.target.value as KeyType)}
          disabled={pending}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        >
          {KEY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="withdraw-key">Chave PIX</Label>
        <Input id="withdraw-key" value={pixKey} onChange={(e) => setPixKey(e.target.value)} disabled={pending} autoComplete="off" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={ownKey} onChange={(e) => setOwnKey(e.target.checked)} disabled={pending} />
        A chave PIX está no meu nome
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-green-700">Saque solicitado. Você será avisado quando o pagamento sair.</p>}
      <Button type="submit" disabled={pending || !ownKey || !preview.valid}>
        {pending ? "Enviando..." : "Solicitar saque"}
      </Button>
    </form>
  );
}
