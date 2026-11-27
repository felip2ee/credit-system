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

const ERROR_ID = "affiliate-settings-error";

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

  // A action devolve uma frase só para o formulário: o banner de erro descreve os três campos.
  const withError = (a11y: { "aria-describedby"?: string; "aria-invalid"?: true }) => ({
    ...a11y,
    "aria-describedby": [error ? ERROR_ID : null, a11y["aria-describedby"]].filter(Boolean).join(" ") || undefined,
    "aria-invalid": error ? (true as const) : undefined,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regras do programa de afiliados</CardTitle>
        <CardDescription>Valem para todos os Bureaus. Mudanças valem para as próximas comissões e saques.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="hold-days" label="Carência da comissão (dias)" helper="Dias entre a captura do pedido e a liberação da comissão. De 0 a 365 dias.">
            {(a11y) => <Input {...withError(a11y)} inputMode="numeric" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} disabled={isPending} />}
          </Field>
          <Field id="fee-fixed" label="Taxa fixa de saque (R$)" helper="Valor descontado de cada saque, em reais. Use 0 para não cobrar taxa fixa.">
            {(a11y) => <Input {...withError(a11y)} inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} disabled={isPending} />}
          </Field>
          <Field id="fee-percent" label="Taxa de saque (%)" helper="Percentual descontado de cada saque. De 0 a 100. Use 0 para não cobrar percentual.">
            {(a11y) => <Input {...withError(a11y)} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} disabled={isPending} />}
          </Field>
          {error && (
            <div id={ERROR_ID}>
              <StatusBanner tone="danger" title={error} />
            </div>
          )}
          {saved && !error && <StatusBanner tone="success" title="Regras salvas." />}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
