"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateFinancingScenario } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  BUYER_LABEL,
  PROPERTY_LABEL,
  SELLER_LABEL,
  type BuyerProfile,
  type FinancingScenario,
  type PropertyKind,
  type SellerKind,
} from "@/lib/checklists/real-estate";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function FinancingScenarioCard({
  opportunityId,
  initial,
}: {
  opportunityId: string;
  initial: FinancingScenario;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [scenario, setScenario] = useState<FinancingScenario>(initial);

  const set = <K extends keyof FinancingScenario>(
    key: K,
    value: FinancingScenario[K]
  ) => {
    setScenario((s) => ({ ...s, [key]: value }));
    setSaved(false);
  };

  const apply = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateFinancingScenario(opportunityId, scenario);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Selecione o cenário para gerar o checklist de documentos correto. Os
        documentos já enviados são preservados ao trocar o cenário.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="fin-buyer">Perfil do comprador</Label>
          <select
            id="fin-buyer"
            className={SELECT_CLASS}
            value={scenario.buyer}
            onChange={(e) => set("buyer", e.target.value as BuyerProfile)}
            disabled={isPending}
          >
            {(Object.keys(BUYER_LABEL) as BuyerProfile[]).map((b) => (
              <option key={b} value={b}>
                {BUYER_LABEL[b]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="fin-property">Imóvel</Label>
          <select
            id="fin-property"
            className={SELECT_CLASS}
            value={scenario.property}
            onChange={(e) => set("property", e.target.value as PropertyKind)}
            disabled={isPending}
          >
            {(Object.keys(PROPERTY_LABEL) as PropertyKind[]).map((p) => (
              <option key={p} value={p}>
                {PROPERTY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="fin-seller">Vendedor</Label>
          <select
            id="fin-seller"
            className={SELECT_CLASS}
            value={scenario.seller}
            onChange={(e) => set("seller", e.target.value as SellerKind)}
            disabled={isPending}
          >
            {(Object.keys(SELLER_LABEL) as SellerKind[]).map((s) => (
              <option key={s} value={s}>
                {SELLER_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={scenario.married}
              onChange={(e) => set("married", e.target.checked)}
              disabled={isPending}
            />
            Comprador casado (incluir cônjuge)
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={apply} disabled={isPending}>
          {isPending ? "Gerando checklist..." : "Aplicar cenário"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && (
          <p className="text-sm text-emerald-600">Checklist atualizado.</p>
        )}
      </div>
    </div>
  );
}
