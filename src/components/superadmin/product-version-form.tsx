"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createProductVersion } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nonNegativeMoneyError, normalizeMoney } from "@/lib/catalog/money-input";
import { StatusBanner } from "@/components/ui/status-banner";

export function ProductVersionForm({
  productId,
  productCode,
  currentDepsProduct,
  currentBaseCost,
  currentBaseCostPerPartner,
}: {
  productId: string;
  productCode: string;
  currentDepsProduct: string | null;
  currentBaseCost: string;
  currentBaseCostPerPartner: string;
}) {
  const hasPartner = productCode === "dossie_empresarial";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [depsProduct, setDepsProduct] = useState(currentDepsProduct ?? "");
  const [baseCost, setBaseCost] = useState(currentBaseCost);
  const [baseCostPerPartner, setBaseCostPerPartner] = useState(currentBaseCostPerPartner);
  const [partnerCostError, setPartnerCostError] = useState<string | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = nonNegativeMoneyError(baseCost);
    const partnerInvalid = hasPartner ? nonNegativeMoneyError(baseCostPerPartner) : null;
    setCostError(invalid);
    setPartnerCostError(partnerInvalid);
    setSaved(false);
    if (invalid || partnerInvalid) return;
    setError(null);
    startTransition(async () => {
      const result = await createProductVersion({
        productId,
        depsProduct,
        baseCost: normalizeMoney(baseCost),
        baseCostPerPartner: hasPartner ? normalizeMoney(baseCostPerPartner) : "0.00",
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="version-deps">Nome DEPS</Label>
        <Input id="version-deps" value={depsProduct} onChange={(e) => setDepsProduct(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="version-cost">{hasPartner ? "Custo padrão da empresa (R$)" : "Custo padrão (R$)"}</Label>
        <Input
          id="version-cost"
          inputMode="decimal"
          value={baseCost}
          onChange={(e) => setBaseCost(e.target.value)}
        />
        {costError && <p className="text-sm text-destructive">{costError}</p>}
      </div>
      {hasPartner && (
        <div className="space-y-2">
          <Label htmlFor="version-cost-partner">Custo padrão por sócio (R$)</Label>
          <Input
            id="version-cost-partner"
            inputMode="decimal"
            value={baseCostPerPartner}
            onChange={(e) => setBaseCostPerPartner(e.target.value)}
          />
          {partnerCostError && <p className="text-sm text-destructive">{partnerCostError}</p>}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <StatusBanner tone="success" title="Nova versão criada." />}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Criar nova versão"}
      </Button>
    </form>
  );
}
