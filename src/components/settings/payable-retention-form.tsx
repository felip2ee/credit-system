"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { savePayableRetentionAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";

export function PayableRetentionForm({ initialDays }: { initialDays: number }) {
  const router = useRouter();
  const [days, setDays] = useState(String(initialDays));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  const parsedDays = days.trim() === "" ? NaN : Number(days);

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await savePayableRetentionAction({ days: parsedDays });
      setConfirming(false);
      if (res.error) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  };

  // Baixar o prazo libera na hora o que já está retido: só esse caso pede confirmação.
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (parsedDays < initialDays) setConfirming(true);
    else save();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prazo de retenção</CardTitle>
        <CardDescription>
          Por quantos dias o valor a receber fica retido antes de poder ser repassado. Vale para todos os Bureaus.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            id="retention-days"
            label="Dias de retenção"
            helper="De 0 a 3650 dias. Com 0, o valor fica liberado na hora. Com 30, cada venda só entra no repasse 30 dias depois de capturada. A mudança vale também para os valores que já estão retidos."
            error={error}
          >
            {(a11y) => <Input {...a11y} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={isPending} />}
          </Field>
          {saved && !error && <StatusBanner tone="success" title="Prazo salvo." />}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Baixar o prazo de retenção?"
        role="alertdialog"
        dismissible={!isPending}
      >
        <p className="text-sm text-muted-foreground">
          O prazo passa de {initialDays} para {parsedDays} dias e vale também para os valores que já estão retidos: o que
          já passou do novo prazo fica liberado para repasse na hora.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" autoFocus onClick={() => setConfirming(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" onClick={save} disabled={isPending}>
            {isPending ? "Salvando..." : "Baixar o prazo"}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
