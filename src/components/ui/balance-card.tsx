"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";

import { displayBalance } from "./balance";
import { Card } from "./card";

interface BalanceCardProps {
  label?: string;
  // Valor já formatado, ex.: "R$ 123,45".
  value: string;
  // Mostra o olho para ocultar o valor. Começa visível.
  hideable?: boolean;
  hint?: React.ReactNode;
  // Botão em pílula (use <Button variant="onBrand">).
  action?: React.ReactNode;
  className?: string;
}

// Cartão de saldo: fundo verde escuro da marca (#007A76, branco 5,2:1), texto branco em negrito.
export function BalanceCard({ label = "Saldo", value, hideable = false, hint, action, className }: BalanceCardProps) {
  const [hidden, setHidden] = React.useState(false);
  return (
    <Card variant="hero" className={cn("space-y-4 p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-bold">{label}</p>
          <p className="mt-1 text-4xl font-bold tabular-nums leading-tight">
            <span aria-hidden={hidden || undefined}>{displayBalance(value, hidden)}</span>
            {hidden && <span className="sr-only">{label} oculto</span>}
          </p>
        </div>
        {hideable && (
          <button
            type="button"
            onClick={() => setHidden((h) => !h)}
            aria-label={hidden ? `Mostrar ${label.toLowerCase()}` : `Ocultar ${label.toLowerCase()}`}
            className="-m-1 flex size-12 shrink-0 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {hidden ? <EyeOff aria-hidden className="size-6" /> : <Eye aria-hidden className="size-6" />}
          </button>
        )}
      </div>
      {hint && <div className="text-base">{hint}</div>}
      {action && <div className="[&>*]:w-full">{action}</div>}
    </Card>
  );
}
