"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveAffiliateSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AffiliateSettings } from "@/lib/settings/readers";
import { StatusBanner } from "@/components/ui/status-banner";

type AffiliateField = "holdDays" | "fixed" | "percent";

// Frases de validação de saveAffiliateSettings (src/actions/settings.ts:193-197) que apontam um campo só.
// "Valor inválido." vale para a taxa fixa e para a percentual: não aponta nenhum.
const FIELD_BY_ERROR: Record<string, AffiliateField> = {
  "Informe dias inteiros.": "holdDays",
  "Dias inválidos.": "holdDays",
  "Use no máximo 365 dias.": "holdDays",
  "A taxa percentual vai de 0 a 100.": "percent",
};

export function AffiliateSettingsForm({ initial }: { initial: AffiliateSettings }) {
  const router = useRouter();
  const [holdDays, setHoldDays] = useState(String(initial.holdDays));
  const [fixed, setFixed] = useState(initial.withdrawalFee.fixed);
  const [percent, setPercent] = useState(initial.withdrawalFee.percent);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveAffiliateSettings({ holdDays: Number(holdDays), fixed, percent });
      if (res.error) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  };

  // A action devolve uma frase só; ela só marca o campo a que se refere. Outro erro fica só no banner.
  const fieldOf = error ? FIELD_BY_ERROR[error] : undefined;
  const fieldError = (field: AffiliateField) => (fieldOf === field ? error : null);
  const edit = (set: (value: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    set(e.target.value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regras do programa de afiliados</CardTitle>
        <CardDescription>Valem para todos os Bureaus. Mudanças valem para as próximas comissões e saques.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="hold-days" label="Carência da comissão (dias)" error={fieldError("holdDays")} helper="Dias entre a captura do pedido e a liberação da comissão. De 0 a 365 dias.">
            {(a11y) => <Input {...a11y} inputMode="numeric" value={holdDays} onChange={edit(setHoldDays)} disabled={isPending} />}
          </Field>
          <Field id="fee-fixed" label="Taxa fixa de saque (R$)" error={fieldError("fixed")} helper="Valor descontado de cada saque, em reais. Use 0 para não cobrar taxa fixa.">
            {(a11y) => <Input {...a11y} inputMode="decimal" value={fixed} onChange={edit(setFixed)} disabled={isPending} />}
          </Field>
          <Field id="fee-percent" label="Taxa de saque (%)" error={fieldError("percent")} helper="Percentual descontado de cada saque. De 0 a 100. Use 0 para não cobrar percentual.">
            {(a11y) => <Input {...a11y} inputMode="decimal" value={percent} onChange={edit(setPercent)} disabled={isPending} />}
          </Field>
          {error && !fieldOf && <StatusBanner tone="danger" title={error} />}
          {saved && !error && <StatusBanner tone="success" title="Regras salvas." />}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
