"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createProductVersion } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { moneyError, normalizeMoney } from "./money";

export function ProductVersionForm({
  productId,
  currentDepsProduct,
  currentBaseCost,
}: {
  productId: string;
  currentDepsProduct: string | null;
  currentBaseCost: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [depsProduct, setDepsProduct] = useState(currentDepsProduct ?? "");
  const [baseCost, setBaseCost] = useState(currentBaseCost);
  const [costError, setCostError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = moneyError(baseCost);
    setCostError(invalid);
    setSaved(false);
    if (invalid) return;
    setError(null);
    startTransition(async () => {
      const result = await createProductVersion({
        productId,
        depsProduct,
        baseCost: normalizeMoney(baseCost),
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
        <Label htmlFor="version-cost">Custo padrão (R$)</Label>
        <Input
          id="version-cost"
          inputMode="decimal"
          value={baseCost}
          onChange={(e) => setBaseCost(e.target.value)}
        />
        {costError && <p className="text-sm text-destructive">{costError}</p>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Nova versão criada.</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Criar nova versão"}
      </Button>
    </form>
  );
}
