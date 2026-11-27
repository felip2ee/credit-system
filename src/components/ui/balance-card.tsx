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
  // "dark": hero verde escuro do painel admin (número branco, rótulo amarelo). Padrão: amarelo do portal.
  tone?: "brand" | "dark";
  className?: string;
}

// O valor cresce com a fonte só até caber numa linha (10vw): quebrar no meio do número atrapalha a leitura do saldo.
// Cartão de saldo: fundo amarelo forte (#FFC400), texto verde escuro em negrito (10:1). tone="dark": verde #0B3A2E, texto branco.
export function BalanceCard({ label = "Saldo", value, hideable = false, hint, action, storageKey, tone = "brand", className }: BalanceCardProps) {
  const dark = tone === "dark";
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
    <Card variant={dark ? "dark" : "hero"} className={cn("space-y-4 p-5", dark && "space-y-3 p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[6rem] flex-1">
          <p className={cn("text-base font-bold", dark && "text-[13px] text-primary")}>{label}</p>
          <p className={cn("mt-1 break-words text-[length:min(2.25rem,10vw)] font-bold tabular-nums leading-tight", dark && "font-heading text-[length:min(2rem,10vw)]")}>
            <span aria-hidden={hidden || undefined}>{displayBalance(value, hidden)}</span>
            {hidden && <span className="sr-only">{label} oculto</span>}
          </p>
        </div>
        {hideable && (
          <button
            type="button"
            onClick={toggle}
            aria-label={hidden ? `Mostrar ${label.toLowerCase()}` : `Ocultar ${label.toLowerCase()}`}
            className={cn("-m-1 ml-auto flex size-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2", dark ? "size-10 hover:bg-white/15 focus-visible:ring-primary" : "hover:bg-primary-foreground/15 focus-visible:ring-primary-foreground")}
          >
            {/* O ícone mostra a ação, como no chip do cabeçalho: olho = mostrar, olho riscado = ocultar. */}
            {hidden ? <Eye aria-hidden className="size-6" /> : <EyeOff aria-hidden className="size-6" />}
          </button>
        )}
      </div>
      {hint && <div className={cn("text-base", dark && "text-[13px] text-muted-foreground")}>{hint}</div>}
      {action && <div className="flex flex-col gap-3 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">{action}</div>}
    </Card>
  );
}
