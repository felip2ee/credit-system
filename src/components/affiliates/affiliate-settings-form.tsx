"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveAffiliateSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AffiliateSettings } from "@/lib/settings/readers";
import { StatusBanner } from "@/components/ui/status-banner";

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Regras do programa de afiliados</CardTitle>
        <CardDescription>Valem para todos os Bureaus. Mudanças valem para as próximas comissões e saques.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="hold-days">Carência da comissão (dias)</Label>
            <Input id="hold-days" inputMode="numeric" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} disabled={isPending} />
            <p className="text-sm text-muted-foreground">Dias entre a captura do pedido e a liberação da comissão.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fee-fixed">Taxa fixa de saque (R$)</Label>
            <Input id="fee-fixed" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} disabled={isPending} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fee-percent">Taxa de saque (%)</Label>
            <Input id="fee-percent" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} disabled={isPending} />
          </div>
          {error && (
            <StatusBanner tone="danger" title={error} />
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
