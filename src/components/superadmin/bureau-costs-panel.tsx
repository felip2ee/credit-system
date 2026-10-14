"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauProductCost } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { listBureauCosts } from "@/lib/catalog/queries";
import { formatBRL, moneyError, normalizeMoney } from "./money";

type BureauCost = Awaited<ReturnType<typeof listBureauCosts>>[number];

function CostRow({ bureauId, row }: { bureauId: string; row: BureauCost }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cost, setCost] = useState("");
  const [costError, setCostError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = moneyError(cost);
    setCostError(invalid);
    if (invalid) return;
    setError(null);
    startTransition(async () => {
      const result = await setBureauProductCost({
        bureauId,
        productId: row.productId,
        cost: normalizeMoney(cost),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setCost("");
      router.refresh();
    });
  };

  return (
    <li className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name}</span>
        <span className="text-xs text-muted-foreground">{row.code}</span>
        {!row.productActive && <Badge variant="muted">Produto inativo</Badge>}
        <span className="ml-auto font-medium">{formatBRL(row.effectiveCost)}</span>
        <Badge variant={row.source === "override" ? "default" : "muted"}>
          {row.source === "override" ? "Override" : "Padrão"}
        </Badge>
      </div>
      <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2">
        <div className="space-y-1">
          <Input
            aria-label={`Novo custo de ${row.name} (R$)`}
            inputMode="decimal"
            placeholder="Novo custo (R$)"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="w-48"
          />
          {costError && <p className="text-sm text-destructive">{costError}</p>}
        </div>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Salvando..." : "Definir override"}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {row.history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Histórico</summary>
          <ul className="mt-1 space-y-1">
            {row.history.map((h) => (
              <li key={h.id}>
                {formatBRL(h.cost)} em {new Date(h.createdAt).toLocaleString("pt-BR")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function BureauCostsPanel({ bureauId, rows }: { bureauId: string; rows: BureauCost[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum produto cadastrado.</p>;
  }
  return (
    <ul className="max-w-3xl space-y-3">
      {rows.map((row) => (
        <CostRow key={row.productId} bureauId={bureauId} row={row} />
      ))}
    </ul>
  );
}
