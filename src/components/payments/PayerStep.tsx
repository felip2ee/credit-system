"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { OwnerPayerView, PayerField } from "@/lib/payers/queries";

import { PAYER_FIELDS, type CheckoutErrors, type PayerKind } from "./checkout-model";

const LABELS: Record<PayerField, string> = {
  name: "Nome completo ou razão social",
  document: "CPF ou CNPJ",
  email: "E-mail",
  phone: "Celular com DDD",
  postalCode: "CEP",
  addressNumber: "Número do endereço",
};

const CHANGE_LABEL: Record<PayerField, string> = {
  name: "nome",
  document: "CPF ou CNPJ",
  email: "e-mail",
  phone: "celular",
  postalCode: "CEP",
  addressNumber: "número do endereço",
};

const INPUT_PROPS: Record<PayerField, { type?: string; inputMode?: "numeric" | "tel" | "email" | "text"; autoComplete: string; placeholder?: string }> = {
  name: { autoComplete: "name" },
  document: { inputMode: "numeric", autoComplete: "off", placeholder: "Somente números" },
  email: { type: "email", inputMode: "email", autoComplete: "email" },
  phone: { type: "tel", inputMode: "tel", autoComplete: "tel", placeholder: "(11) 91234-5678" },
  postalCode: { inputMode: "numeric", autoComplete: "postal-code", placeholder: "00000-000" },
  addressNumber: { autoComplete: "off", placeholder: "Ex.: 120 ou S/N" },
};

function maskedValue(field: PayerField, owner: OwnerPayerView): string | null {
  switch (field) {
    case "name": return owner.name;
    case "document": return owner.documentMasked;
    case "email": return owner.emailMasked;
    case "phone": return owner.phoneMasked;
    case "postalCode": return owner.postalCodeMasked;
    case "addressNumber": return owner.hasAddressNumber ? "informado" : null;
  }
}

type Props = {
  owner: OwnerPayerView;
  /** Campos que faltam para a forma de pagamento escolhida. */
  missing: PayerField[];
  kind: PayerKind;
  onKindChange: (kind: PayerKind) => void;
  values: Record<PayerField, string>;
  onValueChange: (field: PayerField, value: string) => void;
  editing: ReadonlySet<PayerField>;
  onToggleEdit: (field: PayerField) => void;
  declaration: boolean;
  onDeclarationChange: (checked: boolean) => void;
  errors: CheckoutErrors;
  disabled: boolean;
};

export function PayerStep(p: Props) {
  const { owner, missing, kind, errors, disabled } = p;

  const input = (field: PayerField) => (
    <Field key={field} id={`payer-${field}`} label={LABELS[field]} error={errors[field]}>
      {(a11y) => (
        <Input
          {...a11y}
          {...INPUT_PROPS[field]}
          // "Outros": o navegador não deve preencher com os dados de quem está logado.
          autoComplete={kind === "other" ? "off" : INPUT_PROPS[field].autoComplete}
          value={p.values[field]}
          onChange={(e) => p.onValueChange(field, e.target.value)}
          disabled={disabled}
        />
      )}
    </Field>
  );

  const ownerRow = (field: PayerField) => {
    if (missing.includes(field) || p.editing.has(field)) {
      return (
        <div key={field} className="space-y-1">
          {input(field)}
          {!missing.includes(field) && (
            <Button type="button" variant="link" className="h-11 px-0" onClick={() => p.onToggleEdit(field)} disabled={disabled}>
              Manter {CHANGE_LABEL[field]} atual
            </Button>
          )}
        </div>
      );
    }
    const masked = maskedValue(field, owner);
    if (masked === null) return null;
    return (
      <div key={field} className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{LABELS[field]}</p>
          <p className="font-bold tabular-nums [overflow-wrap:anywhere]">{masked}</p>
        </div>
        {field !== "email" && (
          <Button
            type="button"
            variant="link"
            className="h-11 shrink-0"
            aria-label={`Alterar ${CHANGE_LABEL[field]}`}
            onClick={() => p.onToggleEdit(field)}
            disabled={disabled}
          >
            Alterar
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-base font-bold" id="payer-kind-legend">
          Os dados de pagamento são os do dono da conta ou outros?
        </legend>
        <RadioGroup value={kind} onValueChange={(v) => p.onKindChange(v as PayerKind)} aria-labelledby="payer-kind-legend">
          {(
            [
              ["owner", "Do dono da conta"],
              ["other", "De outra pessoa ou empresa"],
            ] as const
          ).map(([value, label]) => (
            <div key={value} className="flex min-h-11 items-center gap-3">
              <RadioGroupItem value={value} id={`payer-kind-${value}`} />
              <Label htmlFor={`payer-kind-${value}`} className="flex-1 cursor-pointer py-2">
                {label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>

      {kind === "owner" ? (
        <div className="space-y-3">{PAYER_FIELDS.map(ownerRow)}</div>
      ) : (
        <div className="space-y-3">
          {PAYER_FIELDS.map(input)}
          <div className="space-y-1">
            <div className="flex min-h-11 items-start gap-3">
              <Checkbox
                id="payer-declaration"
                checked={p.declaration}
                onCheckedChange={(c) => p.onDeclarationChange(c === true)}
                disabled={disabled}
                aria-invalid={errors.declaration ? true : undefined}
                aria-describedby={errors.declaration ? "payer-declaration-error" : undefined}
                className="mt-2"
              />
              <Label htmlFor="payer-declaration" className="cursor-pointer py-2 font-normal">
                Declaro que tenho autorização para usar estes dados. Eles não ficam salvos.
              </Label>
            </div>
            {errors.declaration && (
              <p id="payer-declaration-error" role="alert" className="text-sm font-bold text-destructive">
                {errors.declaration}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
