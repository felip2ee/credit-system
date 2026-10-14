"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createProduct, updateProduct } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { moneyError, normalizeMoney } from "./money";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

export function ProductForm({ mainProducts }: { mainProducts: { code: string; name: string }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"main" | "addon">("main");
  const [addonFor, setAddonFor] = useState<string[]>([]);
  const [depsProduct, setDepsProduct] = useState("");
  const [baseCost, setBaseCost] = useState("");
  const [costError, setCostError] = useState<string | null>(null);

  const toggle = (c: string) =>
    setAddonFor((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = moneyError(baseCost);
    setCostError(invalid);
    if (invalid) return;
    setError(null);
    startTransition(async () => {
      const result = await createProduct({
        code,
        name,
        kind,
        addonFor: kind === "addon" ? addonFor : [],
        depsProduct,
        baseCost: normalizeMoney(baseCost),
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
        <p className="text-xs text-muted-foreground">
          Letras minúsculas, números e _. Não muda depois de criado.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-name">Nome</Label>
        <Input id="product-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-kind">Tipo</Label>
        <select
          id="product-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(e) => setKind(e.target.value as "main" | "addon")}
        >
          <option value="main">Principal</option>
          <option value="addon">Adicional</option>
        </select>
      </div>
      {kind === "addon" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Compatível com</legend>
          {mainProducts.map((p) => (
            <label key={p.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={addonFor.includes(p.code)}
                onChange={() => toggle(p.code)}
              />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="space-y-2">
        <Label htmlFor="product-deps">Nome DEPS</Label>
        <Input id="product-deps" value={depsProduct} onChange={(e) => setDepsProduct(e.target.value)} />
        <p className="text-xs text-muted-foreground">Deixe em branco se o produto não consulta o DEPS.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-cost">Custo padrão (R$)</Label>
        <Input
          id="product-cost"
          inputMode="decimal"
          placeholder="0,00"
          value={baseCost}
          onChange={(e) => setBaseCost(e.target.value)}
        />
        {costError && <p className="text-sm text-destructive">{costError}</p>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Produto ativo
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Salvo.</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
