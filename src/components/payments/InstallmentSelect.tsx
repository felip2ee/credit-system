"use client";

import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";

export type InstallmentOption = { installments: number; totalCents: number; installmentCents: number };

export function installmentLabel(o: InstallmentOption): string {
  return `${o.installments}x de ${formatCurrency(o.installmentCents / 100)} (total ${formatCurrency(o.totalCents / 100)})`;
}

type Props = {
  options: InstallmentOption[];
  value: number;
  onChange: (installments: number) => void;
  disabled: boolean;
  error?: string;
};

// O total e a parcela vêm do servidor. O navegador não calcula taxa.
export function InstallmentSelect({ options, value, onChange, disabled, error }: Props) {
  return (
    <Field id="card-installments" label="Parcelas" helper="A taxa do cartão é paga por você e já está no total." error={error}>
      {(a11y) => (
        <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
          <SelectTrigger {...a11y}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.installments} value={String(o.installments)}>
                {installmentLabel(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}
