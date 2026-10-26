"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { upsertCatalogItem } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { nonNegativeMoneySchema } from "@/lib/validators/catalog";
import { Checkbox } from "@/components/ui/checkbox";

// Máscara pt-BR só na exibição; o envio usa string decimal com ponto.
const toDisplay = (decimal: string) => decimal.replace(".", ",");

function belowCost(priceDisplay: string, cost: string): boolean {
  try {
    return !isPriceSellable(toCents(normalizeMoney(priceDisplay)), toCents(cost));
  } catch {
    return false; // preço vazio ou inválido: a action devolve o erro
  }
}

const PARTNER_INVALID = "Informe um valor por sócio válido, a partir de 0,00.";
const PARTNER_CODE = "dossie_empresarial";

function isNegativeOrInvalid(value: string): boolean {
  return !nonNegativeMoneySchema.safeParse(normalizeMoney(value)).success;
}

interface CatalogEditFormProps {
  entry: CatalogEntry;
  onDone: () => void;
}

// Formulário do diálogo: monta só com o diálogo aberto, então o estado zera a cada abertura.
export function CatalogEditForm({ entry, onDone }: CatalogEditFormProps) {
  const router = useRouter();
  const hasPartner = entry.code === PARTNER_CODE;
  const [price, setPrice] = useState(entry.item ? toDisplay(entry.item.salePrice) : "");
  const [partnerPrice, setPartnerPrice] = useState(
    entry.item ? toDisplay(entry.item.salePricePerPartner) : "0,00",
  );
  const [active, setActive] = useState(entry.item?.active ?? false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [partnerError, setPartnerError] = useState<string | null>(null);

  // Aviso só quando há preço digitado ou gravado.
  const showWarning = price !== "" && belowCost(price, entry.effectiveCost);
  const showPartnerWarning =
    hasPartner && partnerPrice !== "" && belowCost(partnerPrice, entry.effectiveCostPerPartner);

  const save = () => {
    const invalid = moneyError(price);
    const partnerInvalid = hasPartner && isNegativeOrInvalid(partnerPrice) ? PARTNER_INVALID : null;
    setError(invalid);
    setPartnerError(partnerInvalid);
    if (invalid || partnerInvalid) return;
    startTransition(async () => {
      const res = await upsertCatalogItem({
        productId: entry.productId,
        active,
        salePrice: normalizeMoney(price),
        salePricePerPartner: hasPartner ? normalizeMoney(partnerPrice) : "0.00",
      });
      if (!res.error) {
        router.refresh();
        onDone();
        return;
      }
      // A mensagem do conflito por sócio aparece no campo por sócio.
      if (hasPartner && res.error.includes("sócio")) setPartnerError(res.error);
      else setError(res.error);
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Custo: {formatCurrency(Number(entry.effectiveCost))}
        {hasPartner && ` · Por sócio: ${formatCurrency(Number(entry.effectiveCostPerPartner))}`}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`price-${entry.productId}`} className="text-sm">
          {hasPartner ? "Valor da empresa" : "Valor"}
        </Label>
        <Input
          id={`price-${entry.productId}`}
          aria-label={`${hasPartner ? "Valor da empresa" : "Valor"} de ${entry.name}`}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={isPending}
          placeholder="0,00"
          className="min-h-11"
        />
        {showWarning && (
          <Badge variant="destructive" className="mt-1">
            Preço abaixo do custo
          </Badge>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      {hasPartner && (
        <div className="space-y-1">
          <Label htmlFor={`partner-price-${entry.productId}`} className="text-sm">
            Valor por sócio
          </Label>
          <Input
            id={`partner-price-${entry.productId}`}
            aria-label={`Valor por sócio de ${entry.name}`}
            inputMode="decimal"
            value={partnerPrice}
            onChange={(e) => setPartnerPrice(e.target.value)}
            disabled={isPending}
            placeholder="0,00"
            className="min-h-11"
          />
          {showPartnerWarning && (
            <Badge variant="destructive" className="mt-1">
              Valor por sócio abaixo do custo
            </Badge>
          )}
          {partnerError && <p className="text-sm text-destructive">{partnerError}</p>}
        </div>
      )}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Checkbox
          role="switch"
          aria-label={`Ativar ${entry.name}`}
          checked={active}
          onCheckedChange={(checked) => setActive(checked === true)}
          disabled={isPending}
        />
        Produto ativo
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="min-h-11" onClick={onDone} disabled={isPending}>
          Cancelar
        </Button>
        <Button className="min-h-11" onClick={save} disabled={isPending || price === ""}>
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

function CatalogRow({ entry, canWrite }: { entry: CatalogEntry; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const hasPartner = entry.code === PARTNER_CODE;
  const costDisplay = formatCurrency(Number(entry.effectiveCost));
  const partnerCostDisplay = formatCurrency(Number(entry.effectiveCostPerPartner));
  const sale = entry.item ? formatCurrency(Number(entry.item.salePrice)) : "Sem preço";
  const salePartner = entry.item ? formatCurrency(Number(entry.item.salePricePerPartner)) : "Sem preço";

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{entry.name}</div>
        <div className="text-xs text-muted-foreground">{entry.item?.active ? "Ativo" : "Inativo"}</div>
      </TableCell>
      <TableCell>
        {hasPartner ? (
          <div className="space-y-1 text-sm">
            <div>Empresa: {costDisplay}</div>
            <div>Por sócio: {partnerCostDisplay}</div>
          </div>
        ) : (
          costDisplay
        )}
      </TableCell>
      <TableCell>
        {hasPartner ? (
          <div className="space-y-1 text-sm">
            <div>Empresa: {sale}</div>
            <div>Por sócio: {salePartner}</div>
          </div>
        ) : (
          sale
        )}
      </TableCell>
      {canWrite && (
        <TableCell>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            aria-label={`Editar ${entry.name}`}
            onClick={() => setOpen(true)}
          >
            Editar
          </Button>
          <Dialog open={open} onClose={() => setOpen(false)} title={`Editar ${entry.name}`}>
            <CatalogEditForm entry={entry} onDone={() => setOpen(false)} />
          </Dialog>
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
              <TableHead>Venda</TableHead>
              {canWrite && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <CatalogRow key={entry.productId} entry={entry} canWrite={canWrite} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
