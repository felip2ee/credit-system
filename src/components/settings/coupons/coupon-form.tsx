"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createCouponAction, updateCouponAction } from "@/actions/coupons";
import {
  draftFromCoupon,
  EMPTY_DRAFT,
  PRODUCT_LABELS,
  setAllProducts,
  setMaxUses,
  setMaxUsesPerClient,
  toggleProduct,
  validateDraft,
  type CouponDraft,
  type CouponErrors,
  type CouponProductCode,
} from "@/components/settings/coupons/coupon-form-logic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { CouponRow } from "@/lib/coupons/queries";
import { COUPON_PRODUCT_CODES } from "@/lib/validators/coupons";

interface CouponFormProps {
  coupon?: CouponRow;
  onDone: () => void;
}

// Monta só com o diálogo aberto, então o estado zera a cada abertura.
export function CouponForm({ coupon, onDone }: CouponFormProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<CouponDraft>(coupon ? draftFromCoupon(coupon) : EMPTY_DRAFT);
  const [errors, setErrors] = useState<CouponErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const set = <K extends keyof CouponDraft>(key: K, value: CouponDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const result = validateDraft(draft);
    setServerError(null);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const res = coupon
        ? await updateCouponAction({ id: coupon.id, ...result.values })
        : await createCouponAction(result.values);
      if (res.error) {
        setServerError(res.error);
        return;
      }
      router.refresh();
      onDone();
    });
  };

  const percent = draft.kind === "percent";

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Salvar vale para os próximos pedidos dos seus clientes.</p>
        <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={onDone} disabled={isPending}>
          Cancelar
        </Button>
      </div>

      <Field id="coupon-code" label="Código" helper="De 6 a 32 letras, números, _ ou -." error={errors.code}>
        {(a11y) => (
          <Input
            {...a11y}
            autoFocus
            value={draft.code}
            onChange={(e) => set("code", e.target.value)}
            disabled={isPending}
            autoCapitalize="characters"
            autoComplete="off"
            className="uppercase"
          />
        )}
      </Field>

      <div role="group" aria-labelledby="coupon-kind-label" className="space-y-1.5">
        <Label id="coupon-kind-label">Tipo de desconto</Label>
        <RadioGroup
          value={draft.kind}
          onValueChange={(v) => set("kind", v === "fixed" ? "fixed" : "percent")}
          disabled={isPending}
          className="grid-cols-2"
        >
          <div className="flex min-h-11 items-center gap-2">
            <RadioGroupItem id="coupon-kind-percent" value="percent" />
            <Label htmlFor="coupon-kind-percent">Percentual (%)</Label>
          </div>
          <div className="flex min-h-11 items-center gap-2">
            <RadioGroupItem id="coupon-kind-fixed" value="fixed" />
            <Label htmlFor="coupon-kind-fixed">Valor fixo (R$)</Label>
          </div>
        </RadioGroup>
      </div>

      <Field
        id="coupon-value"
        label={percent ? "Percentual de desconto (%)" : "Valor do desconto (R$)"}
        helper={percent ? "Ex.: 10 ou 12,5" : "Ex.: 25,00"}
        error={errors.value}
      >
        {(a11y) => (
          <Input
            {...a11y}
            inputMode="decimal"
            value={draft.value}
            onChange={(e) => set("value", e.target.value)}
            disabled={isPending}
            placeholder={percent ? "10" : "0,00"}
          />
        )}
      </Field>

      <div role="group" aria-labelledby="coupon-scope-label" className="space-y-1.5">
        <Label id="coupon-scope-label">Produtos</Label>
        <RadioGroup
          value={draft.allProducts ? "all" : "chosen"}
          onValueChange={(v) => setDraft((d) => setAllProducts(d, v === "all"))}
          disabled={isPending}
        >
          <div className="flex min-h-11 items-center gap-2">
            <RadioGroupItem id="coupon-scope-all" value="all" />
            <Label htmlFor="coupon-scope-all">Todos os produtos</Label>
          </div>
          <div className="flex min-h-11 items-center gap-2">
            <RadioGroupItem id="coupon-scope-chosen" value="chosen" />
            <Label htmlFor="coupon-scope-chosen">Só produtos escolhidos</Label>
          </div>
        </RadioGroup>
        {!draft.allProducts && (
          <div className="ml-8 space-y-1">
            {COUPON_PRODUCT_CODES.map((code: CouponProductCode) => (
              <div key={code} className="flex min-h-11 items-center gap-3">
                <Checkbox
                  id={`coupon-product-${code}`}
                  checked={draft.productCodes.includes(code)}
                  onCheckedChange={() => setDraft((d) => toggleProduct(d, code))}
                  disabled={isPending}
                  aria-describedby={errors.productCodes ? "coupon-products-error" : undefined}
                />
                <Label htmlFor={`coupon-product-${code}`}>{PRODUCT_LABELS[code]}</Label>
              </div>
            ))}
            {errors.productCodes && (
              <p id="coupon-products-error" role="alert" className="text-sm font-bold text-destructive">
                {errors.productCodes}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="coupon-max-uses"
          label="Limite de usos"
          helper="Vazio = ilimitado."
          error={errors.maxUses}
        >
          {(a11y) => (
            <Input
              {...a11y}
              inputMode="numeric"
              value={draft.maxUses}
              onChange={(e) => setDraft((d) => setMaxUses(d, e.target.value))}
              disabled={isPending}
              placeholder="Ilimitado"
            />
          )}
        </Field>
        <Field
          id="coupon-max-per-client"
          label="Limite por cliente"
          helper="Com limite de usos, o padrão é 1. Vazio = ilimitado."
          error={errors.maxUsesPerClient}
        >
          {(a11y) => (
            <Input
              {...a11y}
              inputMode="numeric"
              value={draft.maxUsesPerClient}
              onChange={(e) => setDraft((d) => setMaxUsesPerClient(d, e.target.value))}
              disabled={isPending}
              placeholder="Ilimitado"
            />
          )}
        </Field>
        <Field id="coupon-valid-from" label="Válido a partir de" helper="Vazio = já vale." error={errors.validFrom}>
          {(a11y) => (
            <Input
              {...a11y}
              type="date"
              value={draft.validFrom}
              onChange={(e) => set("validFrom", e.target.value)}
              disabled={isPending}
            />
          )}
        </Field>
        <Field id="coupon-valid-until" label="Válido até" helper="Vazio = sem fim." error={errors.validUntil}>
          {(a11y) => (
            <Input
              {...a11y}
              type="date"
              value={draft.validUntil}
              onChange={(e) => set("validUntil", e.target.value)}
              disabled={isPending}
            />
          )}
        </Field>
      </div>

      {serverError && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="submit" className="min-h-11" disabled={isPending}>
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
