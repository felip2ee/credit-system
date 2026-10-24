"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauProductCost } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { listBureauCosts } from "@/lib/catalog/queries";
import { nonNegativeMoneyError, normalizeMoney } from "@/lib/catalog/money-input";
import { formatBRL } from "./money";

type BureauCost = Awaited<ReturnType<typeof listBureauCosts>>[number];

const PARTNER_CODE = "dossie_empresarial";

/** Corpo da action: o custo por sócio só vale no Dossiê Empresarial; nos demais fica 0.00. */
export function buildBureauCostInput(
  bureauId: string,
  row: Pick<BureauCost, "productId" | "code">,
  cost: string,
  costPerPartner: string,
) {
  return {
    bureauId,
    productId: row.productId,
    cost: normalizeMoney(cost),
    costPerPartner: row.code === PARTNER_CODE ? normalizeMoney(costPerPartner) : "0.00",
  };
}

function CostRow({ bureauId, row }: { bureauId: string; row: BureauCost }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cost, setCost] = useState("");
  const [costPerPartner, setCostPerPartner] = useState("");
  const [costError, setCostError] = useState<string | null>(null);
  const [partnerError, setPartnerError] = useState<string | null>(null);
  const hasPartner = row.code === PARTNER_CODE;
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = nonNegativeMoneyError(cost);
    const partnerInvalid = hasPartner ? nonNegativeMoneyError(costPerPartner) : null;
    setCostError(invalid);
    setPartnerError(partnerInvalid);
    if (invalid || partnerInvalid) return;
    setError(null);
    startTransition(async () => {
      const result = await setBureauProductCost(
        buildBureauCostInput(bureauId, row, cost, costPerPartner),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setCost("");
      setCostPerPartner("");
      router.refresh();
    });
  };

  return (
    <li className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name}</span>
        <span className="text-xs text-muted-foreground">{row.code}</span>
        {!row.productActive && <Badge variant="muted">Produto inativo</Badge>}
        <span className="ml-auto text-right font-medium">
          {hasPartner ? "Empresa: " : ""}
          {formatBRL(row.effectiveCost)}
          {hasPartner && <span className="block">Por sócio: {formatBRL(row.effectiveCostPerPartner)}</span>}
        </span>
        <Badge variant={row.source === "override" ? "default" : "muted"}>
          {row.source === "override" ? "Override" : "Padrão"}
        </Badge>
      </div>
      <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2">
        <div className="space-y-1">
          <Input
            aria-label={`${hasPartner ? "Novo custo da empresa" : "Novo custo"} de ${row.name} (R$)`}
            inputMode="decimal"
            placeholder={hasPartner ? "Custo da empresa (R$)" : "Novo custo (R$)"}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="w-48"
          />
          {costError && <p className="text-sm text-destructive">{costError}</p>}
        </div>
        {hasPartner && (
          <div className="space-y-1">
            <Input
              aria-label={`Novo custo por sócio de ${row.name} (R$)`}
              inputMode="decimal"
              placeholder="Custo por sócio (R$)"
              value={costPerPartner}
              onChange={(e) => setCostPerPartner(e.target.value)}
              className="w-48"
            />
            {partnerError && <p className="text-sm text-destructive">{partnerError}</p>}
          </div>
        )}
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
                {formatBRL(h.cost)}
                {hasPartner && ` + ${formatBRL(h.costPerPartner)} por sócio`} em {new Date(h.createdAt).toLocaleString("pt-BR")}
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
