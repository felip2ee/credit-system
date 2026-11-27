"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { displayBalance } from "@/components/ui/balance";
import { Card } from "@/components/ui/card";

interface HideableStatProps {
  label: string;
  // Valor já formatado, ex.: "R$ 123,45".
  value: string;
  hint: string;
  // Nó já renderizado: um componente (função) não passa do servidor para este componente de cliente.
  icon: React.ReactNode;
}

// Mesmo visual do Stat, com botão para ocultar o valor. Começa visível; a escolha não é guardada.
export function HideableStat({ label, value, hint, icon }: HideableStatProps) {
  const [hidden, setHidden] = useState(false);
  return (
    <Card className="flex h-full items-center gap-3 p-4">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-soft text-brand-soft-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        <p className="break-words text-xl font-bold leading-tight md:text-2xl tabular-nums">
          <span aria-hidden={hidden || undefined}>{displayBalance(value, hidden)}</span>
          {hidden && <span className="sr-only">{label} oculto</span>}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        onClick={() => setHidden((h) => !h)}
        aria-label={hidden ? `Mostrar ${label.toLowerCase()}` : `Ocultar ${label.toLowerCase()}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* O ícone mostra a ação: olho = mostrar, olho riscado = ocultar. */}
        {hidden ? <Eye aria-hidden className="size-5" /> : <EyeOff aria-hidden className="size-5" />}
      </button>
    </Card>
  );
}
