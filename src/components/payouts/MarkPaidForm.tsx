"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { markPayoutPaidAction } from "@/actions/payouts";
import { RECEIPT_ACCEPT, validateReceiptFile } from "@/components/payouts/payout-logic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MarkPaidForm({ payoutId }: { payoutId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // O servidor decide; esta checagem só poupa o envio.
    const problem = validateReceiptFile(file);
    if (problem || !file) return setError(problem);
    setError(null);
    const formData = new FormData();
    formData.set("payoutId", payoutId);
    formData.set("receipt", file);
    startTransition(async () => {
      const res = await markPayoutPaidAction(formData);
      if (res.error) return setError(res.error);
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <Input
        type="file"
        accept={RECEIPT_ACCEPT}
        aria-label="Comprovante do repasse (PDF, PNG ou JPEG, até 5 MB)"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={isPending}
        className="h-auto max-w-xs"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Enviando..." : "Marcar como pago"}
      </Button>
    </form>
  );
}
