"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauCommissionOverrideAction } from "@/actions/catalog";
import { setBureauAffiliatePctAction } from "@/actions/affiliates-superadmin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

type FormId = "override" | "affiliate";

export function BureauCommissionPanel({ bureauId, effective, history, affiliatePct, canWrite }: BureauCommissionPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [override, setOverride] = useState(effective.source === "override" ? pctToInput(effective.pct) : "");
  const [affiliate, setAffiliate] = useState(pctToInput(affiliatePct));
  // Um erro e um aviso por formulário: cada um aparece no campo do formulário que falhou.
  const [errors, setErrors] = useState<Partial<Record<FormId, string>>>({});
  const [saved, setSaved] = useState<{ form: FormId; message: string } | null>(null);

  const run = (form: FormId, label: string, call: () => Promise<{ error: string | null }>) => {
    setErrors({});
    setSaved(null);
    startTransition(async () => {
      const res = await call();
      if (res.error) return setErrors({ [form]: res.error });
      setSaved({ form, message: label });
      router.refresh();
    });
  };

  const saveOverride = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePctInput(override);
    if (!parsed.ok) return setErrors({ override: parsed.error });
    run("override", "Override salvo.", () => setBureauCommissionOverrideAction({ bureauId, pct: parsed.value }));
  };

  const saveAffiliate = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePctInput(affiliate);
    if (!parsed.ok) return setErrors({ affiliate: parsed.error });
    run("affiliate", "% de afiliados salva.", () => setBureauAffiliatePctAction({ bureauId, pct: String(parsed.value) }));
  };

  const savedFor = (form: FormId) => saved?.form === form && !errors[form] && <StatusBanner tone="success" title={saved.message} />;

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
          <p className="text-base text-muted-foreground">
            A soma da % do Bureau com a % de afiliados não pode passar de 100%. Uma % de afiliados vale para todos os afiliados do Bureau,
            sobre o preço bruto, e é paga pela plataforma.
          </p>
          <form onSubmit={saveOverride} noValidate className="space-y-3">
            <Field
              id="override-pct"
              label="Override da comissão (%)"
              helper="Vale para as vendas novas. Pedidos já reservados mantêm a % de quando foram reservados."
              error={errors.override}
              className="sm:max-w-sm"
            >
              {(a11y) => <Input {...a11y} inputMode="decimal" value={override} onChange={(e) => setOverride(e.target.value)} />}
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={isPending}>Definir override</Button>
              <Button
                type="button"
                variant="outline"
                disabled={isPending || effective.source !== "override"}
                onClick={() => {
                  setOverride("");
                  run("override", "Voltou à % global.", () => setBureauCommissionOverrideAction({ bureauId, pct: null }));
                }}
              >
                Usar % global
              </Button>
            </div>
            {savedFor("override")}
          </form>
          <form onSubmit={saveAffiliate} noValidate className="space-y-3">
            <Field id="affiliate-pct" label="% de afiliados do Bureau" error={errors.affiliate} className="sm:max-w-sm">
              {(a11y) => <Input {...a11y} inputMode="decimal" value={affiliate} onChange={(e) => setAffiliate(e.target.value)} />}
            </Field>
            <Button type="submit" disabled={isPending}>Salvar % de afiliados</Button>
            {savedFor("affiliate")}
          </form>
        </>
      )}
      {!canWrite && <p className="text-sm text-muted-foreground">% de afiliados do Bureau: {formatPct(affiliatePct)}</p>}
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
