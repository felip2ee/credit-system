"use client";

import type { Ref } from "react";

import { fromCents } from "@/lib/catalog/money";
import { isTopupAmountCents, type ReferencePriceRow } from "@/lib/catalog/reference-prices";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

type Props = {
  priceRows: ReferencePriceRow[];
  amount: string;
  onAmountChange: (amount: string) => void;
  /** Clique numa linha de preço: preenche o valor e foca o campo. */
  onPick: (amount: string) => void;
  error?: string;
  disabled: boolean;
  amountRef: Ref<HTMLInputElement>;
};

// Etapa 1: tabela de preços (cada linha preenche o valor) e o campo de valor.
export function AmountStep({ priceRows, amount, onAmountChange, onPick, error, disabled, amountRef }: Props) {
  return (
    <div className="space-y-3">
      {priceRows.length > 0 && (
        <section aria-labelledby="price-ref-title" className="space-y-2 rounded-md border border-border bg-muted p-3">
          <h3 id="price-ref-title" className="text-base font-bold">
            Quanto custa cada dossiê
          </h3>
          <ul className="space-y-2">
            {priceRows.map((row) => {
              const ok = isTopupAmountCents(row.cents);
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    disabled={disabled || !ok}
                    onClick={() => onPick(fromCents(row.cents).replace(".", ","))}
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{row.label}</span>
                      <span className="block text-muted-foreground">
                        {ok ? formatCurrency(row.cents / 100) : "Fora do limite de recarga (R$ 10,00 a R$ 5.000,00)"}
                      </span>
                    </span>
                    {ok && <span className="shrink-0 font-bold">Recarregar {formatCurrency(row.cents / 100)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground">
            O valor da recarga é creditado inteiro no saldo. Pix e cartão têm taxa, mostrada antes de pagar.
          </p>
        </section>
      )}
      <Field id="topup-amount" label="Valor (R$ 10,00 a R$ 5.000,00)" error={error}>
        {(a11y) => (
          <Input {...a11y} ref={amountRef} inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => onAmountChange(e.target.value)} disabled={disabled} />
        )}
      </Field>
    </div>
  );
}
