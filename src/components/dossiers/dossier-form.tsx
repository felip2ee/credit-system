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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { countBillablePartners, orderTotalCents } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";
import { formatCurrency } from "@/lib/utils";
import { counterOrderSchema } from "@/lib/validators/order";

type OrderFormValues = z.input<typeof counterOrderSchema>;

export interface CatalogOption {
  code: string;
  name: string;
  // Preço de venda do catálogo, decimal em string. Nunca digitado pelo operador.
  price: string;
  // Valor por sócio do catálogo; só vale no Dossiê Empresarial.
  pricePerPartner: string;
}

interface DossierFormProps {
  products: CatalogOption[];
}

const EMPRESARIAL_PRODUCT = "dossie_empresarial";
const PF_PRODUCT = "dossie_pf";

export function DossierForm({ products }: DossierFormProps) {
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
      buyerProfileId: null,
      subject: { name: "", document: "" },
      contactEmail: "",
      contactPhone: "",
      partners: [],
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: "partners" });

  const productCode = watch("productCode");
  const partnerCount = countBillablePartners(watch("partners") ?? [], watch("subject.document"));
  const product = products.find((p) => p.code === productCode);
  const isEmpresarial = productCode === EMPRESARIAL_PRODUCT;
  const isPf = productCode === PF_PRODUCT;
  const total = product
    ? orderTotalCents({ code: product.code as OrderProductCode, price: product.price, pricePerPartner: product.pricePerPartner }, partnerCount) / 100
    : 0;

  // Trocar de produto descarta os sócios: só o Dossiê Empresarial os tem.
  useEffect(() => {
    if (!isEmpresarial) replace([]);
  }, [isEmpresarial, replace]);

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
      <StatusBanner
        tone="attention"
        title="Nenhum produto à venda no catálogo."
        description="Ative um produto em Configurações > Catálogo."
      />
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
              <Select
                value={productCode}
                onValueChange={(value) => setValue("productCode", value as OrderFormValues["productCode"], { shouldValidate: true })}
                disabled={isPending}
              >
                <SelectTrigger id="productCode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.code} value={p.code}>
                      {p.name} — {formatCurrency(Number(p.price))}
                      {p.code === EMPRESARIAL_PRODUCT ? ` + ${formatCurrency(Number(p.pricePerPartner))} por sócio ou cônjuge` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.productCode && (
                <p className="text-sm text-destructive">{errors.productCode.message}</p>
              )}
            </div>
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
                  <p className="text-sm text-destructive">{errors.subject.document.message}</p>
                )}
                {lookupMsg && (
                  <p className="text-sm text-muted-foreground" aria-live="polite">
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
                {errors.subject?.name && <p className="text-sm text-destructive">{errors.subject.name.message}</p>}
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
                {errors.contactEmail && <p className="text-sm text-destructive">{errors.contactEmail.message}</p>}
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
                {errors.contactPhone && <p className="text-sm text-destructive">{errors.contactPhone.message}</p>}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              O titular recebe o pedido de autorização para consultar o SCR por e-mail e celular.
            </p>
          </div>

          {/* Sócios (só Dossiê Empresarial) */}
          {isEmpresarial && (
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
                      <p className="text-sm text-destructive">{errors.partners[i]?.document?.message}</p>
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
                      <p className="text-sm text-destructive">{errors.partners[i]?.name?.message}</p>
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
                      <p className="text-sm text-destructive">{errors.partners[i]?.email?.message}</p>
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
              {errors.partners?.message && <p className="text-sm text-destructive">{errors.partners.message}</p>}
              <p className="text-sm text-muted-foreground">
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
