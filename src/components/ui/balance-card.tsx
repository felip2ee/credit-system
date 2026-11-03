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
  // Chave do localStorage que guarda a preferência de ocultar. Sem ela, o estado vale só nesta página.
  storageKey?: string;
  className?: string;
}

// Cartão de saldo: fundo verde profundo da marca (#0A3329, branco 13:1), texto branco em negrito.
export function BalanceCard({ label = "Saldo", value, hideable = false, hint, action, storageKey, className }: BalanceCardProps) {
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    if (!storageKey) return;
    try {
      setHidden(localStorage.getItem(storageKey) === "1");
    } catch {
      // localStorage indisponível: saldo fica visível.
    }
  }, [storageKey]);

  function toggle() {
    const next = !hidden;
    setHidden(next);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      // Sem persistência: vale só nesta página.
    }
  }

  return (
    <Card variant="hero" className={cn("space-y-4 p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-bold">{label}</p>
          <p className="mt-1 break-words text-4xl font-bold tabular-nums leading-tight">
            <span aria-hidden={hidden || undefined}>{displayBalance(value, hidden)}</span>
            {hidden && <span className="sr-only">{label} oculto</span>}
          </p>
        </div>
        {hideable && (
          <button
            type="button"
            onClick={toggle}
            aria-label={hidden ? `Mostrar ${label.toLowerCase()}` : `Ocultar ${label.toLowerCase()}`}
            className="-m-1 flex size-12 shrink-0 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {/* O ícone mostra a ação, como no chip do cabeçalho: olho = mostrar, olho riscado = ocultar. */}
            {hidden ? <Eye aria-hidden className="size-6" /> : <EyeOff aria-hidden className="size-6" />}
          </button>
        )}
      </div>
      {hint && <div className="text-base">{hint}</div>}
      {action && <div className="flex flex-col gap-3 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">{action}</div>}
    </Card>
  );
}
