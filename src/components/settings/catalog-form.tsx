"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { upsertCatalogItem } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isPriceSellable, toCents } from "@/lib/catalog/money";
import { moneyError, normalizeMoney } from "@/lib/catalog/money-input";
import type { CatalogEntry } from "@/lib/catalog/queries";
import { formatCurrency } from "@/lib/utils";

// Máscara pt-BR só na exibição; o envio usa string decimal com ponto.
const toDisplay = (decimal: string) => decimal.replace(".", ",");

function belowCost(priceDisplay: string, cost: string): boolean {
  try {
    return !isPriceSellable(toCents(normalizeMoney(priceDisplay)), toCents(cost));
  } catch {
    return false; // preço vazio ou inválido: a action devolve o erro
  }
}

function CatalogRow({
  entry,
  canWrite,
  mainOnSale,
}: {
  entry: CatalogEntry;
  canWrite: boolean;
  mainOnSale: boolean;
}) {
  const router = useRouter();
  const [price, setPrice] = useState(entry.item ? toDisplay(entry.item.salePrice) : "");
  const [active, setActive] = useState(entry.item?.active ?? false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const addonBlocked = entry.kind === "addon" && !mainOnSale;
  const costDisplay = formatCurrency(Number(entry.effectiveCost));
  // Aviso só quando há preço digitado ou gravado.
  const costNotSet = Number(entry.effectiveCost) === 0;
  const showWarning = price !== "" && belowCost(price, entry.effectiveCost);

  const save = () => {
    const invalid = moneyError(price);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await upsertCatalogItem({
        productId: entry.productId,
        active,
        salePrice: normalizeMoney(price),
      });
      if (res.error) setError(res.error);
      else router.refresh();
    });
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{entry.name}</div>
        <div className="text-xs text-muted-foreground">
          {entry.kind === "addon" ? `Adicional de: ${(entry.addonFor ?? []).join(", ")}` : "Principal"}
        </div>
        {addonBlocked && (
          <div className="text-xs text-muted-foreground">
            Requer um produto principal compatível à venda.
          </div>
        )}
      </TableCell>
      <TableCell>{costDisplay}</TableCell>
      <TableCell>
        <Input
          aria-label={`Preço de ${entry.name}`}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={!canWrite || isPending}
          placeholder="0,00"
          className="w-32"
        />
        {showWarning && (
          <Badge variant="destructive" className="mt-1">
            {costNotSet ? "Custo não definido" : "Preço abaixo do custo"}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <input
          type="checkbox"
          role="switch"
          aria-label={`Ativar ${entry.name}`}
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          disabled={!canWrite || isPending || (addonBlocked && !active)}
          className="h-4 w-4"
        />
      </TableCell>
      {canWrite && (
        <TableCell>
          <Button size="sm" onClick={save} disabled={isPending || price === ""}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </TableCell>
      )}
    </TableRow>
  );
}

export function CatalogForm({
  entries,
  canWrite,
}: {
  entries: CatalogEntry[];
  canWrite: boolean;
}) {
  const mainsOnSale = new Set(entries.filter((e) => e.kind === "main" && e.onSale).map((e) => e.code));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Produtos</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Custo</TableHead>
              <TableHead>Preço de venda</TableHead>
              <TableHead>Ativo</TableHead>
              {canWrite && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <CatalogRow
                key={entry.productId}
                entry={entry}
                canWrite={canWrite}
                mainOnSale={(entry.addonFor ?? []).some((code) => mainsOnSale.has(code))}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
