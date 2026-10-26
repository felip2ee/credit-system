"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { savePayableRetentionAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";

export function PayableRetentionForm({ initialDays }: { initialDays: number }) {
  const router = useRouter();
  const [days, setDays] = useState(String(initialDays));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await savePayableRetentionAction({ days: days.trim() === "" ? NaN : Number(days) });
      if (res.error) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Prazo de retenção</CardTitle>
        <CardDescription>
          Por quantos dias o valor a receber fica retido antes de poder ser repassado. Vale para todos os Bureaus.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="retention-days">Dias de retenção</Label>
            <Input id="retention-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={isPending} />
            <p className="text-sm text-muted-foreground">De 0 a 3650 dias. Com 0, o valor fica liberado na hora.</p>
          </div>
          {error && <StatusBanner tone="danger" title={error} />}
          {saved && !error && <StatusBanner tone="success" title="Prazo salvo." />}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
