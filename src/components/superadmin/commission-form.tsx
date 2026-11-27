"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveBureauCommissionAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";
import { parsePctInput, pctToInput } from "./price-input";

export function CommissionForm({ initialPct }: { initialPct: number | null }) {
  const router = useRouter();
  const [pct, setPct] = useState(initialPct === null ? "" : pctToInput(String(initialPct)));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const parsed = parsePctInput(pct);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    startTransition(async () => {
      const res = await saveBureauCommissionAction({ pct: parsed.value });
      if (res.error) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {initialPct === null && (
        <StatusBanner
          tone="attention"
          title="Sem % definida"
          description="Nenhuma venda é aceita até você definir a comissão dos Bureaus."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Comissão do Bureau</CardTitle>
          <CardDescription>
            % do preço bruto de cada venda que fica com o Bureau. Vale para todo Bureau sem override. A plataforma fica
            com o resto, menos a comissão do afiliado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5" noValidate>
            <Field
              id="commission-pct"
              label="Comissão (%)"
              helper="De 0 a 99,99, com até 2 casas. Vale só para vendas futuras."
              error={error}
            >
              {(a11y) => <Input {...a11y} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} disabled={isPending} />}
            </Field>
            {saved && !error && <StatusBanner tone="success" title="Comissão salva." />}
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando..." : "Salvar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
