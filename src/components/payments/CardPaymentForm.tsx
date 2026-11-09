"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import { formatExpiry, type CardDraft, type CheckoutErrors } from "./checkout-model";
import { InstallmentSelect, type InstallmentOption } from "./InstallmentSelect";

type Props = {
  card: CardDraft;
  onChange: (card: CardDraft) => void;
  options: InstallmentOption[];
  installments: number;
  onInstallmentsChange: (installments: number) => void;
  errors: CheckoutErrors;
  disabled: boolean;
};

// Estado só no pai, em memória: nada de localStorage, URL ou contexto global. O pai zera ao enviar e ao falhar.
export function CardPaymentForm({ card, onChange, options, installments, onInstallmentsChange, errors, disabled }: Props) {
  const set = (patch: Partial<CardDraft>) => onChange({ ...card, ...patch });
  const common = { disabled, spellCheck: false, autoCorrect: "off", autoCapitalize: "off" } as const;
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-2 text-base font-bold">Dados do cartão</legend>
      <Field id="card-number" label="Número do cartão" error={errors.number}>
        {(a11y) => (
          <Input {...a11y} {...common} inputMode="numeric" autoComplete="cc-number" maxLength={23} value={card.number} onChange={(e) => set({ number: e.target.value })} />
        )}
      </Field>
      <Field id="card-holder" label="Nome impresso no cartão" error={errors.holderName}>
        {(a11y) => (
          <Input {...a11y} {...common} autoComplete="cc-name" maxLength={60} value={card.holderName} onChange={(e) => set({ holderName: e.target.value })} />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="card-expiry" label="Validade (MM/AA)" error={errors.expiry}>
          {(a11y) => (
            <Input {...a11y} {...common} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA" maxLength={5} value={card.expiry} onChange={(e) => set({ expiry: formatExpiry(e.target.value) })} />
          )}
        </Field>
        <Field id="card-cvv" label="Código (CVV)" error={errors.cvv}>
          {(a11y) => (
            <Input {...a11y} {...common} type="password" inputMode="numeric" autoComplete="cc-csc" maxLength={4} value={card.cvv} onChange={(e) => set({ cvv: e.target.value })} />
          )}
        </Field>
      </div>
      <InstallmentSelect options={options} value={installments} onChange={onInstallmentsChange} disabled={disabled} error={errors.installments} />
    </fieldset>
  );
}
