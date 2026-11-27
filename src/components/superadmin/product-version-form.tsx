"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createProductVersion } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatBRL } from "./money";
import { normalizeMoney } from "@/lib/catalog/money-input";
import { StatusBanner } from "@/components/ui/status-banner";
import { buildSalePrices } from "./price-input";
import { PARTNER_CODE, valuesErrors, type ValuesErrors } from "./product-wizard-steps";

// Ordem dos campos na tela, para focar o primeiro inválido.
const FIELD_IDS = {
  baseCost: "version-cost",
  baseCostPerPartner: "version-cost-partner",
  salePrice: "version-price",
  salePricePerPartner: "version-price-partner",
} as const;

export function ProductVersionForm({
  productId,
  productCode,
  currentDepsProduct,
  currentBaseCost,
  currentBaseCostPerPartner,
  currentSalePrice,
  currentSalePricePerPartner,
}: {
  productId: string;
  productCode: string;
  currentDepsProduct: string | null;
  currentBaseCost: string;
  currentBaseCostPerPartner: string;
  currentSalePrice: string | null;
  currentSalePricePerPartner: string;
}) {
  const hasPartner = productCode === PARTNER_CODE;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [depsProduct, setDepsProduct] = useState(currentDepsProduct ?? "");
  const [baseCost, setBaseCost] = useState(currentBaseCost);
  const [baseCostPerPartner, setBaseCostPerPartner] = useState(currentBaseCostPerPartner);
  const [salePrice, setSalePrice] = useState(currentSalePrice ?? "");
  const [salePricePerPartner, setSalePricePerPartner] = useState(currentSalePricePerPartner);
  const [errors, setErrors] = useState<ValuesErrors>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const noPrice = salePrice.trim() === "";
  // Só exibição: o payload usa os mesmos valores normalizados, sem passar por aqui.
  const shown = (value: string) => formatBRL(normalizeMoney(value.trim() || "0"));
  const changes: [string, string][] = [
    [hasPartner ? "Custo interno da empresa" : "Custo interno", shown(baseCost)],
    ...(hasPartner ? [["Custo interno por sócio", shown(baseCostPerPartner)] as [string, string]] : []),
    [hasPartner ? "Preço de venda da empresa" : "Preço de venda", noPrice ? "sem preço (não está à venda)" : shown(salePrice)],
    ...(hasPartner ? [["Preço de venda por sócio", shown(salePricePerPartner)] as [string, string]] : []),
  ];

  // O botão não envia: valida e abre a confirmação, porque o preço da nova versão vale para os pedidos futuros.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = valuesErrors({ baseCost, baseCostPerPartner, salePrice, salePricePerPartner, hasPartner });
    setErrors(found);
    setSaved(false);
    setError(null);
    const first = (Object.keys(FIELD_IDS) as (keyof typeof FIELD_IDS)[]).find((key) => found[key]);
    if (first) return document.getElementById(FIELD_IDS[first])?.focus();
    setConfirmOpen(true);
  };

  const confirm = () => {
    startTransition(async () => {
      const result = await createProductVersion({
        productId,
        ...buildSalePrices(salePrice, salePricePerPartner, hasPartner),
        depsProduct,
        baseCost: normalizeMoney(baseCost),
        baseCostPerPartner: hasPartner ? normalizeMoney(baseCostPerPartner) : "0.00",
      });
      setConfirmOpen(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <Field id="version-deps" label="Nome DEPS">
        {(a11y) => <Input {...a11y} value={depsProduct} onChange={(e) => setDepsProduct(e.target.value)} />}
      </Field>
      <Field id={FIELD_IDS.baseCost} label={hasPartner ? "Custo interno da empresa (R$)" : "Custo interno (R$)"} error={errors.baseCost}>
        {(a11y) => <Input {...a11y} inputMode="decimal" value={baseCost} onChange={(e) => setBaseCost(e.target.value)} />}
      </Field>
      {hasPartner && (
        <Field id={FIELD_IDS.baseCostPerPartner} label="Custo interno por sócio (R$)" error={errors.baseCostPerPartner}>
          {(a11y) => (
            <Input {...a11y} inputMode="decimal" value={baseCostPerPartner} onChange={(e) => setBaseCostPerPartner(e.target.value)} />
          )}
        </Field>
      )}
      <Field
        id={FIELD_IDS.salePrice}
        label={hasPartner ? "Preço de venda da empresa (R$)" : "Preço de venda (R$)"}
        helper={noPrice ? "Sem preço = não está à venda. Nenhum Bureau vende o produto." : undefined}
        error={errors.salePrice}
      >
        {(a11y) => <Input {...a11y} inputMode="decimal" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />}
      </Field>
      {hasPartner && (
        <Field id={FIELD_IDS.salePricePerPartner} label="Preço de venda por sócio (R$)" error={errors.salePricePerPartner}>
          {(a11y) => (
            <Input {...a11y} inputMode="decimal" value={salePricePerPartner} onChange={(e) => setSalePricePerPartner(e.target.value)} />
          )}
        </Field>
      )}
      {error && <StatusBanner tone="danger" title={error} />}
      {saved && <StatusBanner tone="success" title="Nova versão criada." />}
      <p className="text-base text-muted-foreground">
        <span className="font-bold text-foreground">O que acontece: </span>
        A nova versão muda o preço dos pedidos futuros. A versão anterior não muda.
      </p>
      <Button type="submit" disabled={isPending}>
        Criar nova versão
      </Button>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Criar nova versão?" role="alertdialog" dismissible={!isPending} className="max-h-[92vh] overflow-y-auto">
        <p className="text-base">Estes valores passam a valer nos pedidos futuros. A versão anterior não muda.</p>
        <ul className="space-y-1 text-base">
          {changes.map(([label, value]) => (
            <li key={label}>
              {label}: <span className="font-bold">{value}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" onClick={confirm} disabled={isPending}>
            {isPending ? "Criando..." : "Criar nova versão"}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
