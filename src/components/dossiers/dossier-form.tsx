"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Plus, Trash2 } from "lucide-react";

import { lookupCnpj } from "@/actions/holders";
import { openCounterOrderAction } from "@/actions/orders";
import { BuyerPicker, type Buyer } from "@/components/dossiers/buyer-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import { counterOrderSchema } from "@/lib/validators/order";

type OrderFormValues = z.input<typeof counterOrderSchema>;

export interface CatalogOption {
  code: string;
  name: string;
  // Preço de venda do catálogo, decimal em string. Nunca digitado pelo operador.
  price: string;
  addonFor: string[] | null;
}

interface DossierFormProps {
  products: CatalogOption[];
  addons: CatalogOption[];
}

const FULL_PRODUCT = "dossie_pj_completo";
const PF_PRODUCT = "consulta_pf";
const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export function DossierForm({ products, addons }: DossierFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<Buyer | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    control,
    formState: { errors },
  } = useForm<OrderFormValues>({
    resolver: zodResolver(counterOrderSchema),
    defaultValues: {
      productCode: (products[0]?.code ?? "") as OrderFormValues["productCode"],
      withAi: false,
      buyerProfileId: null,
      subject: { name: "", document: "" },
      contactEmail: "",
      contactPhone: "",
      partners: [],
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: "partners" });

  const productCode = watch("productCode");
  const withAi = watch("withAi");
  const product = products.find((p) => p.code === productCode);
  const addon = addons.find((a) => a.addonFor?.includes(productCode));
  const isFull = productCode === FULL_PRODUCT;
  const isPf = productCode === PF_PRODUCT;
  const total = (product ? Number(product.price) : 0) + (withAi && addon ? Number(addon.price) : 0);

  // Trocar de produto descarta o que não vale mais: parecer IA sem adicional e sócios fora do PJ completo.
  useEffect(() => {
    if (!addon) setValue("withAi", false);
    if (!isFull) replace([]);
  }, [addon, isFull, replace, setValue]);

  const onLookup = () => {
    setLookupMsg(null);
    startTransition(async () => {
      const result = await lookupCnpj(getValues("subject.document"));
      if (result.error || !result.data) {
        setLookupMsg(result.error ?? "Falha na consulta.");
        return;
      }
      setValue("subject.name", result.data.name, { shouldValidate: true });
      if (result.data.email && !getValues("contactEmail")) setValue("contactEmail", result.data.email);
      setLookupMsg(`Dados carregados${result.data.situacao ? ` — ${result.data.situacao}` : ""}.`);
    });
  };

  // O schema valida e transforma; a ação valida de novo no servidor com os valores brutos.
  const onSubmit = () => {
    setServerError(null);
    startTransition(async () => {
      const res = await openCounterOrderAction({ ...getValues(), buyerProfileId: buyer?.profileId ?? null });
      if (res.error || !res.id) {
        setServerError(res.error ?? "Falha ao abrir o pedido.");
        return;
      }
      router.push(`/dossiers/${res.id}`);
      router.refresh();
    });
  };

  if (products.length === 0) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Nenhum produto à venda no catálogo. Ative um produto em Configurações &gt; Catálogo.
      </p>
    );
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-lg">Pedido de balcão</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
          {/* Produto e preço do catálogo */}
          <div className="space-y-3 rounded-md border p-4">
            <div className="space-y-1">
              <Label htmlFor="productCode">Produto</Label>
              <select id="productCode" className={SELECT_CLASS} disabled={isPending} {...register("productCode")}>
                {products.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} — {formatCurrency(Number(p.price))}
                  </option>
                ))}
              </select>
              {errors.productCode && (
                <p className="text-xs text-destructive">{errors.productCode.message}</p>
              )}
            </div>
            {addon && (
              <div className="flex items-start gap-2">
                <input
                  id="withAi"
                  type="checkbox"
                  disabled={isPending}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  {...register("withAi")}
                />
                <Label htmlFor="withAi" className="cursor-pointer">
                  Incluir parecer IA (+ {formatCurrency(Number(addon.price))})
                </Label>
              </div>
            )}
            <p className="text-sm" aria-live="polite">
              Total: <span className="font-semibold">{formatCurrency(total)}</span>
            </p>
          </div>

          <BuyerPicker value={buyer} onChange={setBuyer} disabled={isPending} />

          {/* Titular */}
          <div className="space-y-4 rounded-md border p-4">
            <p className="text-sm font-medium">Titular ({isPf ? "pessoa física" : "empresa"})</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="subject-document">{isPf ? "CPF" : "CNPJ"}</Label>
                <div className="flex gap-2">
                  <Input
                    id="subject-document"
                    inputMode="numeric"
                    placeholder={isPf ? "000.000.000-00" : "00.000.000/0000-00"}
                    aria-invalid={Boolean(errors.subject?.document)}
                    disabled={isPending}
                    {...register("subject.document")}
                  />
                  {!isPf && (
                    <Button type="button" variant="outline" onClick={onLookup} disabled={isPending}>
                      Consultar CNPJ
                    </Button>
                  )}
                </div>
                {errors.subject?.document && (
                  <p className="text-xs text-destructive">{errors.subject.document.message}</p>
                )}
                {lookupMsg && (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {lookupMsg}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="subject-name">{isPf ? "Nome" : "Razão social"}</Label>
                <Input
                  id="subject-name"
                  aria-invalid={Boolean(errors.subject?.name)}
                  disabled={isPending}
                  {...register("subject.name")}
                />
                {errors.subject?.name && <p className="text-xs text-destructive">{errors.subject.name.message}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="contactEmail">E-mail do titular</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  placeholder="contato@exemplo.com"
                  aria-invalid={Boolean(errors.contactEmail)}
                  disabled={isPending}
                  {...register("contactEmail")}
                />
                {errors.contactEmail && <p className="text-xs text-destructive">{errors.contactEmail.message}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="contactPhone">Celular do titular</Label>
                <Input
                  id="contactPhone"
                  type="tel"
                  placeholder="(11) 99999-9999"
                  aria-invalid={Boolean(errors.contactPhone)}
                  disabled={isPending}
                  {...register("contactPhone")}
                />
                {errors.contactPhone && <p className="text-xs text-destructive">{errors.contactPhone.message}</p>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              O titular recebe o pedido de autorização para consultar o SCR por e-mail e celular.
            </p>
          </div>

          {/* Sócios (só PJ completo) */}
          {isFull && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Sócios (CPF)</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => append({ document: "", name: "", email: "" })}
                >
                  <Plus className="h-4 w-4" />
                  Adicionar sócio
                </Button>
              </div>
              {fields.map((field, i) => (
                <div key={field.id} className="grid items-start gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <div className="space-y-1">
                    <Label htmlFor={`partner-doc-${i}`}>CPF</Label>
                    <Input
                      id={`partner-doc-${i}`}
                      placeholder="000.000.000-00"
                      aria-invalid={Boolean(errors.partners?.[i]?.document)}
                      disabled={isPending}
                      {...register(`partners.${i}.document`)}
                    />
                    {errors.partners?.[i]?.document && (
                      <p className="text-xs text-destructive">{errors.partners[i]?.document?.message}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`partner-name-${i}`}>Nome</Label>
                    <Input
                      id={`partner-name-${i}`}
                      aria-invalid={Boolean(errors.partners?.[i]?.name)}
                      disabled={isPending}
                      {...register(`partners.${i}.name`)}
                    />
                    {errors.partners?.[i]?.name && (
                      <p className="text-xs text-destructive">{errors.partners[i]?.name?.message}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`partner-email-${i}`}>E-mail do sócio *</Label>
                    <Input
                      id={`partner-email-${i}`}
                      type="email"
                      aria-invalid={Boolean(errors.partners?.[i]?.email)}
                      disabled={isPending}
                      {...register(`partners.${i}.email`)}
                    />
                    {errors.partners?.[i]?.email && (
                      <p className="text-xs text-destructive">{errors.partners[i]?.email?.message}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-6"
                    onClick={() => remove(i)}
                    disabled={isPending}
                    aria-label={`Remover sócio ${i + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {errors.partners?.message && <p className="text-xs text-destructive">{errors.partners.message}</p>}
              <p className="text-xs text-muted-foreground">
                Digite o CPF completo de cada sócio: o bureau mascara o CPF no quadro societário.
              </p>
            </div>
          )}

          <div aria-live="polite">{serverError && <p className="text-sm text-destructive">{serverError}</p>}</div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Abrindo pedido..." : "Abrir pedido"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
