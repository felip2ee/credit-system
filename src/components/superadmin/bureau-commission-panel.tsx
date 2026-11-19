"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauCommissionOverrideAction } from "@/actions/catalog";
import { setBureauAffiliatePctAction } from "@/actions/affiliates-superadmin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import type { CommissionRateRow } from "@/lib/commission/queries";
import type { EffectiveCommission } from "@/lib/catalog/queries";
import { formatPct, parsePctInput, pctToInput } from "./price-input";

interface BureauCommissionPanelProps {
  bureauId: string;
  effective: EffectiveCommission;
  history: CommissionRateRow[];
  affiliatePct: string;
  canWrite: boolean;
}

const SOURCE_LABEL = { override: "Override do Bureau", global: "% global", none: "Sem %" } as const;

export function BureauCommissionPanel({ bureauId, effective, history, affiliatePct, canWrite }: BureauCommissionPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [override, setOverride] = useState(effective.source === "override" ? pctToInput(effective.pct) : "");
  const [affiliate, setAffiliate] = useState(pctToInput(affiliatePct));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const run = (label: string, call: () => Promise<{ error: string | null }>) => {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const res = await call();
      if (res.error) return setError(res.error);
      setSaved(label);
      router.refresh();
    });
  };

  const saveOverride = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePctInput(override);
    if (!parsed.ok) return setError(parsed.error);
    run("Override salvo.", () => setBureauCommissionOverrideAction({ bureauId, pct: parsed.value }));
  };

  const saveAffiliate = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePctInput(affiliate);
    if (!parsed.ok) return setError(parsed.error);
    run("% de afiliados salva.", () => setBureauAffiliatePctAction({ bureauId, pct: String(parsed.value) }));
  };

  return (
    <div className="max-w-3xl space-y-4">
      {effective.pct === null && (
        <StatusBanner
          tone="attention"
          title="Sem % de comissão"
          description="Nem a % global nem um override estão definidos. Este Bureau não consegue vender."
        />
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-4">
        <span className="font-medium">% efetiva do Bureau: {formatPct(effective.pct)}</span>
        <Badge variant={effective.source === "override" ? "default" : "muted"}>{SOURCE_LABEL[effective.source]}</Badge>
      </div>
      {canWrite && (
        <>
          <form onSubmit={saveOverride} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="override-pct">Override da comissão (%)</Label>
              <Input id="override-pct" inputMode="decimal" className="w-48" value={override} onChange={(e) => setOverride(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={isPending}>Definir override</Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending || effective.source !== "override"}
              onClick={() => {
                setOverride("");
                run("Voltou à % global.", () => setBureauCommissionOverrideAction({ bureauId, pct: null }));
              }}
            >
              Usar % global
            </Button>
          </form>
          <form onSubmit={saveAffiliate} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="affiliate-pct">% de afiliados do Bureau</Label>
              <Input id="affiliate-pct" inputMode="decimal" className="w-48" value={affiliate} onChange={(e) => setAffiliate(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={isPending}>Salvar % de afiliados</Button>
          </form>
          <p className="text-sm text-muted-foreground">
            Uma % para todos os afiliados do Bureau, sobre o preço bruto, paga pela plataforma. A soma com a % do Bureau não pode passar de 100%.
          </p>
        </>
      )}
      {!canWrite && <p className="text-sm text-muted-foreground">% de afiliados do Bureau: {formatPct(affiliatePct)}</p>}
      {error && <StatusBanner tone="danger" title={error} />}
      {saved && !error && <StatusBanner tone="success" title={saved} />}
      {history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Histórico do override</summary>
          <ul className="mt-1 space-y-1">
            {history.map((h) => (
              <li key={h.id}>
                {h.pct === null ? "Voltou à % global" : formatPct(h.pct)} em {h.createdAt.toLocaleString("pt-BR")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
