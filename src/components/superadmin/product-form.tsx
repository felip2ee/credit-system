"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createProduct, updateProduct } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nonNegativeMoneyError, normalizeMoney } from "@/lib/catalog/money-input";
import { StatusBanner } from "@/components/ui/status-banner";
import { Checkbox } from "@/components/ui/checkbox";

const PARTNER_CODE = "dossie_empresarial";

export function ProductForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [depsProduct, setDepsProduct] = useState("");
  const [baseCost, setBaseCost] = useState("");
  const [baseCostPerPartner, setBaseCostPerPartner] = useState("");
  const [costError, setCostError] = useState<string | null>(null);
  const [partnerCostError, setPartnerCostError] = useState<string | null>(null);
  const hasPartner = code === PARTNER_CODE;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = nonNegativeMoneyError(baseCost);
    const partnerInvalid = hasPartner ? nonNegativeMoneyError(baseCostPerPartner) : null;
    setCostError(invalid);
    setPartnerCostError(partnerInvalid);
    if (invalid || partnerInvalid) return;
    setError(null);
    startTransition(async () => {
      const result = await createProduct({
        code,
        name,
        depsProduct,
        baseCost: normalizeMoney(baseCost),
        baseCostPerPartner: hasPartner ? normalizeMoney(baseCostPerPartner) : "0.00",
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push(`/superadmin/products/${result.id}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="grid max-w-xl gap-4">
      <div className="space-y-2">
        <Label htmlFor="product-code">Código</Label>
        <Input id="product-code" value={code} onChange={(e) => setCode(e.target.value)} />
        <p className="text-sm text-muted-foreground">
          Letras minúsculas, números e _. Não muda depois de criado.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-name">Nome</Label>
        <Input id="product-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-deps">Nome DEPS</Label>
        <Input id="product-deps" value={depsProduct} onChange={(e) => setDepsProduct(e.target.value)} />
        <p className="text-sm text-muted-foreground">Deixe em branco se o produto não consulta o DEPS.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-cost">{hasPartner ? "Custo padrão da empresa (R$)" : "Custo padrão (R$)"}</Label>
        <Input
          id="product-cost"
          inputMode="decimal"
          placeholder="0,00"
          value={baseCost}
          onChange={(e) => setBaseCost(e.target.value)}
        />
        {costError && <p className="text-sm text-destructive">{costError}</p>}
      </div>
      {hasPartner && (
        <div className="space-y-2">
          <Label htmlFor="product-cost-partner">Custo padrão por sócio (R$)</Label>
          <Input
            id="product-cost-partner"
            inputMode="decimal"
            placeholder="0,00"
            value={baseCostPerPartner}
            onChange={(e) => setBaseCostPerPartner(e.target.value)}
          />
          {partnerCostError && <p className="text-sm text-destructive">{partnerCostError}</p>}
        </div>
      )}
      {error && <StatusBanner tone="danger" title={error} />}
      <Button type="submit" disabled={isPending} className="w-fit">
        {isPending ? "Criando..." : "Criar produto"}
      </Button>
    </form>
  );
}

export function ProductEditForm({
  product,
}: {
  product: { id: string; name: string; active: boolean };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(product.name);
  const [active, setActive] = useState(product.active);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateProduct({ id: product.id, name, active });
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
        <Label htmlFor="edit-name">Nome</Label>
        <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <label className="flex items-center gap-3 text-base">
        <Checkbox checked={active} onCheckedChange={(checked) => setActive(checked === true)} />
        Produto ativo
      </label>
      {error && <StatusBanner tone="danger" title={error} />}
      {saved && <StatusBanner tone="success" title="Salvo." />}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
