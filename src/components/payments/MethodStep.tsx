"use client";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import type { Method } from "./checkout-model";

const METHODS = [
  ["PIX", "Pix"],
  ["CREDIT_CARD", "Cartão de crédito, até 12x"],
] as const;

type Props = { value: Method; onChange: (method: Method) => void; pixDisabled: boolean; disabled: boolean };

// Etapa 2: forma de pagamento. O título da etapa já nomeia o grupo.
export function MethodStep({ value, onChange, pixDisabled, disabled }: Props) {
  return (
    <fieldset disabled={disabled}>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as Method)} aria-label="Forma de pagamento">
        {METHODS.map(([id, label]) => (
          <div key={id} className="flex min-h-11 items-center gap-3">
            <RadioGroupItem value={id} id={`method-${id}`} disabled={id === "PIX" && pixDisabled} />
            <Label htmlFor={`method-${id}`} className="flex-1 cursor-pointer py-2">
              {label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
